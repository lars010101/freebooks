'use strict';
/**
 * freeBooks — Inbox (A5 §10: the unified action review queue)
 *
 * A tab strip over four review queues — Transactions, Partners, New Rule,
 * Failed Input — the human's input channel (the complement of event.list,
 * the agent's). Rebuilt 2026-09-09 from a single FB.list with a hidden
 * `f`-cycling status filter and group-header/fold into a real tab strip
 * with live counts, one FB.list instance per tab (the established
 * multi-instance pattern accounting.js/settings.js/payables-bills.js +
 * payables-partners.js already use for tabs whose columns genuinely
 * differ — FB.list's columns are fixed per instance, there is no API to
 * reconfigure them after creation).
 *
 * Transactions unifies journal proposals and bill drafts (Class A) into
 * one flat table: one verb vocabulary (approve/reject, "approve is the
 * post" for both — bill.draft.post/bill.draft.reject underneath a bill
 * row, journal.approve/journal.reject underneath a journal row), one
 * status vocabulary (Proposed/Rejected — a bill draft's real DB status is
 * still 'draft'/'rejected', normalized to 'proposed'/'rejected' for
 * display only). Sortable Date/Counterparty/Amount/Status (FB.list's
 * native `sortable:true`, no hand-rolled sort needed). Orphaned files
 * moved to Documents (2026-09-08) — resolving an unlinked file on disk
 * isn't a decide-here approval, it belongs with the rest of the file
 * registry, not this review queue.
 *
 * Partners and New Rule (mapping_suggestion) are ported into their own
 * tab with their EXISTING columns/verbs/unfold unchanged — Partners'
 * fully inline-editable row (Vendor/Customer/account/VAT + Duplicate
 * dropdown) is a separate follow-up, not part of this rebuild.
 *
 * Failed Input holds only input_rejection now (rejected journal/bill
 * proposals stay on Transactions, filtered by the Status column filter —
 * they always did; this was never a real merge to undo). New here:
 * unfold shows the actual rejected_lines detail + a working link to the
 * source statement, not just a "Flagged by" meta line.
 */

const { commonStyle, navBar, layoutEnd, getRelevanceFlags, flagsBootstrapJson } = require('./common');

async function handleInboxPage(req, res) {
  const { company } = req.params;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const flags = await getRelevanceFlags(company);
  res.send(buildInboxPage(company, flags));
}

function buildInboxPage(company, flags) {
  const flagsJson = flagsBootstrapJson(flags);
  // Tax code column (Partners tab) gated on vat_registered, same convention
  // journal-voucher.js already uses for its own Tax Code column.
  const vatOn = !flags || flags.vatRegistered !== false;
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
  /* Conditional Currency column (Transactions tab only — data-field scopes
     this to the one table that has a currency column, despite .jrnl-table
     being shared across all four Inbox tabs). Plain display:none is safe
     here (unlike Payables' visibility:collapse-on-<col> approach) because
     this table has no colgroup/table-layout:fixed — no column-track
     mapping to slide out of place by removing a th/td pair. */
  #tab-transactions table.jrnl-table.single-ccy th[data-field="currency"],
  #tab-transactions table.jrnl-table.single-ccy td[data-field="currency"] { display:none; }
  /* .amt is the shared numeric-cell component (common.css) */
  .jrnl-meta td, td.jrnl-meta { color:var(--text-muted); font-size:0.6875rem; font-style:italic; background:var(--bg); }
  tr[data-child-of] td { background:var(--bg); font-size:0.75rem; color:var(--text-muted); }
  /* Status badges use the shared .badge component (common.css) — see statusBadge() below */
  /* Per-row type glyph (Transactions only — Partners/New Rule/Failed Input
     each hold one type, no glyph needed there). */
  .type-glyph { font-size:0.8125rem; margin-right:4px; opacity:.65; }
  .t-account {
    display:inline-flex; align-items:center; justify-content:center; width:14px; height:14px;
    border:1px solid var(--text-muted); border-radius:2px; font-weight:700; font-size:0.625rem;
    font-family:Georgia,serif; opacity:.85; vertical-align:-1px;
  }
  /* .tabs/.tab/.tab-panel now in common.css (2026-09-09) — this page's own
     tighter spacing is the one deliberate deviation, kept as an override. */
  .tabs { margin-bottom:20px; }
  .tab-count { display:inline-block; min-width:16px; padding:0 5px; border-radius:20px; font-size:0.6875rem; font-weight:700; margin-left:5px; }
  .tab-count.zero { color:var(--text-faint); }
  .tab-count.some { background:var(--warning-bg); color:var(--warning); }
  /* A4 §4.7 — source-document count badge + no-source-document warning, on
     the parent row (2026-09-10: previously ALSO duplicated as an
     always-rendered unfold child row — every proposed row's unfold grew by
     an extra row beyond the mockup for no added information, since this
     badge already said the same thing). Clicking the badge opens the doc
     list in a modal instead — source docs come from the parent row. */
  .ul-doc-link { cursor:pointer; }
  .ul-badge { display:inline-block; margin-left:6px; padding:1px 7px; border-radius:9px;
    font-size:0.6875rem; font-weight:600; background:var(--info-bg); color:var(--info); white-space:nowrap; }
  .ul-warn  { display:inline-block; margin-left:6px; padding:1px 7px; border-radius:9px;
    font-size:0.6875rem; font-weight:700; background:var(--danger-bg); color:var(--danger); white-space:nowrap;
    border:1px solid var(--danger-border); }
  .jrnl-att-head { font-size:0.6875rem; font-weight:700; text-transform:uppercase; letter-spacing:.03em;
    color:var(--text-muted); margin:0 0 4px; }
  .jrnl-att .fb-attach-row { padding:3px 0; }
  .jrnl-att .fb-att-empty { color:var(--text-faint); font-size:0.75rem; font-style:italic; }
  /* Failed Input unfold — rejected_lines detail (2026-09-09). */
  .discard-detail-doc { margin-bottom:6px; color:var(--text-muted); }
  .discard-line { padding:4px 0; color:var(--text-muted); }
  .discard-line code { background:var(--bg); padding:1px 5px; border-radius:3px; color:var(--text); }
  .source-link { color:var(--info); text-decoration:none; font-weight:600; }
  .source-link:hover { text-decoration:underline; }
  /* calendar-reminders-documents-spec.md §6 — Inbox upload. */
  #inbox-upload-panel { display:none; margin:0 0 14px; padding:12px; border:1px solid var(--border); border-radius:4px; background:var(--bg); }
  #inbox-upload-panel.open { display:block; }
  #inbox-upload-panel select, #inbox-upload-panel input { padding:4px 8px; border:1px solid var(--border); border-radius:3px; font-size:0.8125rem; margin-right:8px; }
  .header { display:flex; justify-content:space-between; align-items:flex-start; }
  .agent-warn {
    display:inline-flex; align-items:center; gap:6px; font-size:0.75rem; font-weight:600;
    color:var(--danger); background:var(--danger-bg); border:1px solid var(--danger-border);
    padding:5px 10px; border-radius:5px; margin:0 0 14px; cursor:pointer; user-select:none;
  }
  /* The [hidden] attribute and .agent-warn's own display rule are equal
     specificity, and this stylesheet loads after the UA one — without this,
     .agent-warn's display:inline-flex wins the tie and the pill (or at least
     its icon) renders regardless of the hidden attribute. */
  .agent-warn[hidden] { display:none; }
  /* Partners tab — every field editable directly on the row, no unfold: the
     whole approve/reject decision happens on one line (2026-09-09). */
  #partners-tbody input[type="text"] {
    padding:4px 6px; border:1px solid var(--border); border-radius:4px; font-size:0.75rem;
    background:var(--surface); color:var(--text); width:72px;
  }
  .source-link { color:var(--info); text-decoration:none; font-weight:600; white-space:nowrap; }
  .source-link:hover { text-decoration:underline; }
</style>
</head>
<body>${navBar(company, 'inbox')}
<div class="page page-wide">
  <div class="header">
    <h1>📥 Inbox: Agent Proposals</h1>
  </div>

  <div class="agent-warn" id="agent-warn" hidden onclick="loadAgentStatus()">
    <span>&#9888;</span>
    <span id="agent-warn-text"></span>
  </div>

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

  <div class="tabs">
    <div class="tab active" onclick="showInboxTab('transactions')">Transactions<span class="tab-count" id="count-transactions"></span></div>
    <div class="tab" onclick="showInboxTab('partners')">Partners<span class="tab-count" id="count-partners"></span></div>
    <div class="tab" onclick="showInboxTab('newrule')">New Rule<span class="tab-count" id="count-newrule"></span></div>
    <div class="tab" onclick="showInboxTab('failedinput')">Failed Input<span class="tab-count" id="count-failedinput"></span></div>
  </div>

  <div id="tab-transactions" class="tab-panel active">
    <table class="jrnl-table">
      <thead><tr>
        <th>Date</th><th>Counterparty</th><th>Description</th>
        <th style="text-align:right">Amount</th><th>CCY</th><th>Status</th><th title="Source documents">&#128206;</th><th>Actions</th>
      </tr></thead>
      <tbody id="txn-tbody"></tbody>
    </table>
  </div>

  <div id="tab-partners" class="tab-panel">
    <table class="jrnl-table">
      <thead><tr>
        <th>Name</th><th>Vendor</th><th>Customer</th>
        <th>Exp account</th><th>AP account</th>${vatOn ? '<th>Tax code</th>' : ''}<th>Source</th><th>Duplicate</th><th>Actions</th>
      </tr></thead>
      <tbody id="partners-tbody"></tbody>
    </table>
  </div>

  <div id="tab-newrule" class="tab-panel">
    <table class="jrnl-table">
      <thead><tr>
        <th>Date</th><th>Pattern</th><th>Suggested account</th>
        ${vatOn ? '<th>Tax code</th>' : ''}<th>Source</th><th>Actions</th>
      </tr></thead>
      <tbody id="newrule-tbody"></tbody>
    </table>
  </div>

  <div id="tab-failedinput" class="tab-panel">
    <table class="jrnl-table">
      <thead><tr>
        <th>Date</th><th>Description</th><th style="text-align:right">Amount</th><th>Reason</th><th>Actions</th>
      </tr></thead>
      <tbody id="failedinput-tbody"></tbody>
    </table>
  </div>
</div>

<script>
window.__fbFlags = ${flagsJson};
var COMPANY = ${JSON.stringify(company)};
var VAT_ON = ${vatOn ? 'true' : 'false'};
var BASE_CURRENCY = (window.__fbFlags && window.__fbFlags.baseCurrency) || 'SGD';

function postAction(action, body, idemKey) {
  var headers = { 'Content-Type': 'application/json' };
  if (idemKey) headers['Idempotency-Key'] = idemKey;
  return fetch('/api/action', {
    method: 'POST', headers: headers,
    body: JSON.stringify(Object.assign({ action: action, companyId: COMPANY }, body))
  }).then(function (r) { return r.json(); });
}

// ── Upload (calendar-reminders-documents-spec.md §6) ─────────────────────────
// Entry point moved to the topbar's global "+" menu (fb-core.js's
// NEW_MENU_ITEMS, 2026-09-09) — it navigates here with ?upload=1, which
// opens the panel directly (see the bottom of this script); this page no
// longer has its own toggle trigger in the header.
document.addEventListener('click', function (e) {
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

// Agent-loop / feed-watcher pipeline status — silent unless something is
// actually broken (mockup: no persistent "Checking..." text line; the
// warning pill only appears when the agent or feed watcher is stopped).
function fmtAgentWarning(d) {
  if (!d) return 'Agent status unavailable';
  var stopped = [];
  if (!d.running) stopped.push('Agent');
  if (d.feedWatcher && !d.feedWatcher.running) stopped.push('Feed watcher');
  if (!stopped.length) return null;
  return stopped.join(' & ') + ' stopped — uploaded documents won\\'t be processed automatically';
}
function loadAgentStatus() {
  var warnEl = document.getElementById('agent-warn');
  var textEl = document.getElementById('agent-warn-text');
  postAction('agent.status', {}).then(function (res) {
    var msg = fmtAgentWarning((res && res.data) || null);
    textEl.textContent = msg || '';
    warnEl.hidden = !msg;
  }).catch(function () {
    textEl.textContent = 'Agent status unavailable';
    warnEl.hidden = false;
  });
}
loadAgentStatus();

function fmtAmt(v) {
  var n = Number(v || 0);
  return n ? '<span class="amt">' + FB.util.fmtAmt(n) + '</span>' : '';
}

// row.status is always the DISPLAY vocabulary here ('proposed'/'rejected'/
// 'open') — a bill row's real DB status ('draft') is normalized to
// 'proposed' at mapTxnItem time, so this needs no per-kind branching.
function statusBadge(row) {
  var s = row.status || '';
  if (s === 'proposed') return '<span class="badge badge-warning">Proposed</span>';
  if (s === 'rejected') {
    var reason = 'Rejected by ' + (row.reviewed_by || '?') + (row.review_note ? ' — ' + row.review_note : '');
    return '<span class="badge badge-danger" title="' + esc(reason) + '">Rejected</span>';
  }
  if (s === 'open') return '<span class="badge badge-danger">Open</span>';
  return '';
}

// A4 §4.7 — parent-row source-document indicator. Only PROPOSED items carry
// it; rejected items show nothing. attachment_count > 0 → "📎 N"; 0 → a
// visible ⚠️ warning icon (R7: warn-not-block). Clickable (2026-09-10): opens
// the actual doc list in a modal — this is the ONLY place source documents
// are shown, not also duplicated as an unfold child row.
function underlagBadge(row) {
  if (row.status !== 'proposed') return '';
  var entityType = row.kind === 'bill' ? 'bill' : 'journal_proposal';
  var entityId = row.kind === 'bill' ? row.bill_id : row.proposal_id;
  var n = Number(row.attachment_count || 0);
  var html = '';
  if (n > 0) {
    html += '<span class="ul-badge" title="' + n + ' source document(s) attached — click to view">\\uD83D\\uDCCE ' + n + '</span>';
  } else {
    html += '<span class="ul-warn" title="No source document attached — egen verifikation permitted (BFL 5 kap)">\\u26A0</span>';
  }
  var warns = Array.isArray(row.warnings) ? row.warnings : [];
  if (n > 0 && warns.indexOf('no_underlag') !== -1) {
    html += '<span class="ul-warn" title="No source document attached">\\u26A0</span>';
  }
  var hasVat = warns.some(function (w) {
    return String(w).indexOf('vat_') === 0 || String(w).toLowerCase().indexOf('vat') !== -1;
  });
  if (hasVat) html += '<span class="ul-warn" title="VAT tolerance flag">\\u26A0</span>';
  return '<a class="ul-doc-link" data-show-docs="1" data-entity-type="' + esc(entityType) + '" data-entity-id="' + esc(entityId) + '">' + html + '</a>';
}

// issue #226 — folded-row fuzzy-duplicate indicator for partner_proposal.
// A hit against an EXISTING partner (kind:'partner') carries that partner's
// id (2026-09-09, partner.proposal.alias) and is actionable: the reviewer
// can resolve the proposal as the same real-world partner instead of
// approving it into a duplicate row. A hit against another PENDING proposal
// (kind:'proposal') has no partner_id yet — neither side is a real partner
// until one of them is resolved — so that case stays an informational badge.
function duplicateBadge(row) {
  if (!row.duplicate_warning) return '';
  var d = row.duplicate_warning;
  var pct = Math.round((Number(d.similarity) || 0) * 100);
  if (d.kind === 'partner' && d.partnerId) {
    // Not data-act: FB.list's own wireChips() intercepts (and
    // stopPropagation()s) EVERY [data-act] element inside its tbody, known
    // verb or not — a distinct attribute name is required for this link's
    // click to ever reach the document-level handler below.
    return '<a class="fb-tag" title="Treat as the same partner as ' + esc(d.name) + ' (' + pct + '% similar) — no new partner will be created" '
      + 'data-partner-alias="1" data-proposal="' + esc(row.proposal_id) + '" data-partner="' + esc(d.partnerId) + '" data-partner-name="' + esc(d.name) + '">'
      + '\\u26A0 alias to ' + esc(d.name) + '</a>';
  }
  var kindLabel = d.kind === 'proposal' ? 'another pending proposal' : 'an existing partner';
  return '<span class="ul-warn" title="Possibly a duplicate of ' + esc(d.name) + ' (' + kindLabel + ', ' + pct + '% similar) — review before approving">\\u26A0 possible duplicate</span>';
}

// Alias flow (2026-09-09) — resolves a Partners-tab row as "the same partner
// as an existing one" via the Duplicate column's actionable link above.
// Delegated at the document level, same idiom as the upload panel's
// data-act handlers, since the link is rebuilt on every FB.list re-render.
document.addEventListener('click', function (e) {
  var link = e.target.closest('[data-partner-alias]');
  if (!link) return;
  var proposalId = link.dataset.proposal;
  var partnerId = link.dataset.partner;
  var partnerName = link.dataset.partnerName;
  var idemKey = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('alias-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  var inFlight = false;
  FB.modal.open({
    title: 'Alias to existing partner',
    body: '<div style="font-size:0.8125rem;color:var(--text);line-height:1.7">'
      + 'Treat this proposal as the <b>same partner</b> as <b>' + esc(partnerName) + '</b>?'
      + '<div style="margin-top:6px;color:var(--text-muted);font-size:0.75rem">No new partner will be created. If this proposal came from a drafted bill, that bill will be relinked to the existing partner.</div>'
      + '</div>',
    buttons: [
      { label: 'Alias', primary: true, requiresConfirm: true, key: 'Enter', hint: 'alias',
        onClick: function (mapi) {
          if (inFlight) return; inFlight = true;
          postAction('partner.proposal.alias', { proposalId: proposalId, partnerId: partnerId }, idemKey)
            .then(function (res) {
              if (!res || res.ok === false || res.error) {
                inFlight = false;
                mapi.error((res && res.error && res.error.message) || 'Request failed'); return;
              }
              mapi.close();
              FB.status.show('Resolved as ' + partnerName, false);
              window.dispatchEvent(new Event('fb:queue-changed'));
              partnersList.load();
            })
            .catch(function (e) { inFlight = false; mapi.error(e.message); });
        } },
      { label: 'Cancel', onClick: function (mapi) { mapi.close(); } }
    ],
    onCancel: function () {}
  });
});

// A4 §4.7 — source-document viewer, opened by clicking the parent row's
// doc badge (2026-09-10, replacing an always-rendered unfold child row that
// duplicated the same badge and inflated every proposed row's unfold by an
// extra row for no added information). Shared by journal proposals AND bill
// drafts (entityType distinguishes the two attachment namespaces). Cache key
// is "entityType:entityId" so a journal proposal and a bill never collide.
var _attCache = {};
function fetchUnderlag(entityType, entityId) {
  var key = entityType + ':' + entityId;
  if (_attCache[key] !== undefined) return Promise.resolve(_attCache[key]);
  return postAction('attachment.list', { entityType: entityType, entityId: entityId })
    .then(function (res) {
      var docs = (res && Array.isArray(res.data)) ? res.data : [];
      _attCache[key] = docs;
      return docs;
    })
    .catch(function () { _attCache[key] = []; return []; });
}
function underlagPanelHtml(docs) {
  if (!docs.length) return FB.attachments.emptyHtml('No source documents attached');
  return docs.map(function (a) {
    return FB.attachments.rowHtml({
      attachment_id: a.attachment_id, filename: a.filename,
      file_size: a.file_size, created_at: a.uploaded_at
    });
  }).join('');
}
function showSourceDocs(entityType, entityId) {
  fetchUnderlag(entityType, entityId).then(function (docs) {
    FB.modal.open({
      title: 'Source documents',
      body: '<div class="jrnl-att">' + underlagPanelHtml(docs) + '</div>',
      buttons: [{ label: 'Close', onClick: function (api) { api.close(); } }]
    });
  });
}
document.addEventListener('click', function (e) {
  var link = e.target.closest('[data-show-docs]');
  if (!link) return;
  showSourceDocs(link.dataset.entityType, link.dataset.entityId);
});

function lineChild(row, l, i) {
  return {
    _key: row._key + ':L' + i, _childOf: row._key,
    account_code: l.account_code || '', description: l.description || '',
    debit: l.debit || 0, credit: l.credit || 0
  };
}

// ── Transactions: journal proposals + bill drafts, unified ─────────────────
// Per-tab glyph — the row's only remaining type signal now that there's no
// group header to carry it.
var TXN_GLYPH = {
  journal: '<span class="type-glyph t-account" title="Journal entry">T</span>',
  bill: '<span class="type-glyph" title="Bill received">\\uD83D\\uDCE9</span>'
};

// journal_proposals.source / the bill-draft equivalent (queryBillDrafts,
// inbox.js server) is stamped 'agent'|'human' from the real actor at
// propose time — 'human' means someone drafted this via the AI chat
// feature rather than the automated pipeline picking it up from a
// document unattended. Worth flagging (a chat-drafted item is more
// directed, less "extracted blind" than a pipeline one) without adding a
// column that reads "agent" on every other row.
function sourceGlyph(row) {
  if (row.source !== 'human') return '';
  return '<span class="type-glyph" title="Drafted via AI chat by ' + esc(row.created_by || '?') + '">\\uD83D\\uDCAC</span>';
}

// Synthesizes the same 2-line DR/CR display a journal proposal's real lines
// give, directly from the bill row's expense_account/ap_account/amount —
// bill-edit.js's fuller line-item model is out of scope here.
function billLines(it) {
  var amt = Number(it.amount) || 0;
  return [
    { account_code: it.expense_account || '', description: it.description || '', debit: amt, credit: 0 },
    { account_code: it.ap_account || '', description: it.counterparty || '', debit: 0, credit: amt }
  ];
}

function mapTxnItem(it) {
  var isBill = it.type === 'bill_draft';
  var lines = isBill ? billLines(it) : (Array.isArray(it.lines) ? it.lines : []);
  var dr = 0, cr = 0;
  lines.forEach(function (l) { dr += Number(l.debit || 0); cr += Number(l.credit || 0); });
  // Display status is always 'proposed'/'rejected' — a bill's real DB
  // status ('draft') is normalized here so statusBadge/underlagBadge and
  // the Status column filter need no per-kind branching.
  var status = isBill ? (it.status === 'draft' ? 'proposed' : it.status) : it.status;
  return {
    _key: (isBill ? 'bill:' : 'jrn:') + it.payload_ref,
    _kind: 'transaction',
    kind: isBill ? 'bill' : 'journal',
    proposal_id: isBill ? null : it.payload_ref,
    bill_id: isBill ? it.payload_ref : null,
    date: it.date,
    counterparty: it.counterparty || '',
    reference: it.reference || '',
    description: it.description || it.summary || '',
    amount: Number(it.amount) || 0,
    currency: isBill ? (it.currency || '') : (lines.length ? (lines[0].currency || '') : ''),
    status: status,
    source: it.source || 'agent',
    created_by: it.created_by || '',
    request_id: it.request_id || '',
    reviewed_by: it.reviewed_by || '',
    review_note: it.review_note || '',
    attachment_count: Number(it.attachment_count || 0),
    warnings: Array.isArray(it.warnings) ? it.warnings : [],
    settlement: it.settlement || null,
    lineCount: lines.length, totalDebit: Math.round(dr * 100) / 100, totalCredit: Math.round(cr * 100) / 100,
    _lines: lines
  };
}

// Both statuses (proposed + rejected) are fetched together — the Status
// column's own filter (already client-side, filterType:'list') is what
// hides rejected by default (see txnList.applyFilterExpr below), not a
// separate server round-trip per filter state the way the old f-cycle
// worked. period_unclosed items are excluded here (they never had real
// approve/reject wiring in the old code's fallthrough either — this is a
// deliberate exclusion, not a regression: they don't belong in a unified,
// typed Transactions row set with no fallback branch to catch them).
function fetchTxnRows() {
  return Promise.all([
    postAction('inbox.list', { status: 'proposed', limit: 100 }),
    postAction('inbox.list', { status: 'rejected', limit: 100 })
  ]).then(function (results) {
    function itemsOf(res) { return (res && res.data && Array.isArray(res.data.items)) ? res.data.items : []; }
    var proposed = itemsOf(results[0]).filter(function (it) { return it.type === 'journal_proposal' || it.type === 'bill_draft'; });
    var rejected = itemsOf(results[1]).filter(function (it) { return it.type === 'journal_proposal' || it.type === 'bill_draft'; });
    updateTabCount('transactions', proposed.length);
    var items = proposed.concat(rejected);
    // Enrich journal_proposal items with parsed lines (children + modal
    // summary); bill_draft items skip enrichment (lines are synthesized
    // locally by billLines()).
    return Promise.all(items.map(function (it) {
      if (it.type !== 'journal_proposal') return it;
      return postAction('journal.proposal.get', { proposalId: it.payload_ref })
        .then(function (g) {
          var d = (g && g.data) || {};
          if (!Array.isArray(d.lines)) d.lines = [];
          return Object.assign(it, d);
        })
        .catch(function () { it.lines = []; return it; });
    }));
  }).then(function (enriched) { return enriched.map(mapTxnItem); });
}

// ── Approve / reject a transaction row (journal or bill) ────────────────
// One modal for both kinds now: approve is the post either way; reject is
// terminal either way (row stays, status flips to rejected, never
// deleted). action/idField/note-requirement differ underneath by kind —
// everything else about the flow is identical.
function reviewTxn(row, verdict) {
  var approve = verdict === 'approve';
  if (approve && row.settlement && row.settlement.blocked) {
    FB.status.show(row.settlement.blockedReason || 'Missing FX setup — cannot approve this proposal.', true);
    return;
  }
  var isBill = row.kind === 'bill';
  var action = isBill ? (approve ? 'bill.draft.post' : 'bill.draft.reject') : (approve ? 'journal.approve' : 'journal.reject');
  var idemKey = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('rev-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  var inFlight = false;
  FB.modal.open({
    title: (approve ? 'Approve' : 'Reject') + ' ' + (isBill ? 'bill' : 'journal batch'),
    body: '<div style="font-size:0.8125rem;color:var(--text);line-height:1.7">'
      + '<div><b>Date:</b> ' + FB.util.fmtDate(row.date) + '</div>'
      + (row.kind === 'journal' && row.lineCount ? '<div><b>Lines:</b> ' + row.lineCount + ' &nbsp; <b>Total debit:</b> ' + FB.util.fmtAmt(row.totalDebit) + (row.currency ? ' ' + esc(row.currency) : '') + '</div>' : '')
      + (row.counterparty ? '<div><b>Counterparty:</b> ' + esc(row.counterparty) + '</div>' : '')
      + (row.amount ? '<div><b>Amount:</b> ' + FB.util.fmtAmt(row.amount) + (row.currency ? ' ' + esc(row.currency) : '') + '</div>' : '')
      + (row.reference ? '<div><b>Reference:</b> ' + esc(row.reference) + '</div>' : '')
      + (row.description ? '<div><b>Description:</b> ' + esc(row.description) + '</div>' : '')
      + '<div style="margin-top:6px;color:var(--text-muted);font-size:0.75rem">Proposed by ' + esc(row.created_by || '?')
      + (row.request_id ? ' · req ' + esc(row.request_id) : '') + '</div>'
      + '</div>',
    noteInput: (isBill && approve) ? undefined : {
      required: !approve,
      label: approve ? 'Note (optional)' : 'Note (required — the proposer reads this via event.list)',
      placeholder: approve ? 'Optional review note' : 'Why is this rejected?'
    },
    buttons: [
      { label: approve ? 'Approve' : 'Reject', primary: approve, danger: !approve,
        requiresConfirm: true, key: 'Enter', hint: approve ? 'approve' : 'reject',
        onClick: function (mapi) {
          if (inFlight) return; inFlight = true;
          var body = {};
          body[isBill ? 'billId' : 'proposalId'] = isBill ? row.bill_id : row.proposal_id;
          if (!(isBill && approve)) {
            var note = mapi.confirmValue();
            body.note = (note && note.trim()) || undefined;
          }
          postAction(action, body, idemKey)
            .then(function (res) {
              if (!res || res.ok === false || res.error) {
                inFlight = false;
                mapi.error((res && res.error && res.error.message) || 'Request failed'); return;
              }
              var d = res.data || {};
              mapi.close();
              FB.status.show(approve
                ? 'Approved — posted ' + (d.reference || d.batchId || d.billId || '')
                : 'Rejected', false);
              window.dispatchEvent(new Event('fb:queue-changed'));
              txnList.load();
            })
            .catch(function (e) { inFlight = false; mapi.error(e.message); });
        } },
      { label: 'Cancel', onClick: function (mapi) { mapi.close(); } }
    ],
    onCancel: function () {}
  });
}

// Conditional Currency column (docs/UI.md — a conditional column is shown
// only when at least one visible row actually needs it): collapses via
// .single-ccy when every currently-loaded transaction shares one currency.
// Mirrors payables-bills.js's _refreshCcyVisibility/_applyCcyColVisibility
// exactly (this table has no INSERT/edit mode to guard against, unlike
// Bills, so that half of Payables' guard is dropped) — same standard,
// no colgroup/table-layout:fixed needed here since this table uses auto
// layout: hiding the th/td pair by data-field doesn't slide any other
// column's track, so plain display:none is enough (see the CSS rule).
var _txnSingleCcy = false;
function _applyTxnCcyVisibility() {
  var tbl = document.querySelector('#tab-transactions table.jrnl-table');
  if (!tbl) return;
  // Checks the Currency column's OWN filter state (.fb-col-filtered, set by
  // fb-list.js's syncHeaderState), not txnList.anyFilterActive() — this
  // list carries a permanent default status:proposed filter (hides
  // rejected items), so "any filter active" is always true here and would
  // permanently defeat the collapse. The guard's actual point — never hide
  // the only way to see/clear a filter ON THIS COLUMN — only cares about a
  // currency filter specifically.
  var ccyTh = tbl.querySelector('th[data-field="currency"]');
  var ccyFiltering = !!(ccyTh && ccyTh.classList.contains('fb-col-filtered'));
  tbl.classList.toggle('single-ccy', _txnSingleCcy && !ccyFiltering);
}
function _refreshTxnCcyVisibility(saved) {
  var rows = saved || [];
  var ccys = {};
  rows.forEach(function (r) { ccys[(r.currency || BASE_CURRENCY || '').toUpperCase()] = 1; });
  _txnSingleCcy = rows.length > 0 && Object.keys(ccys).length === 1;
  _applyTxnCcyVisibility();
}

var txnList = FB.list.create({
  keysId: 'inbox-transactions',
  tbody: 'txn-tbody',
  companyId: function () { return COMPANY; },
  tree: true,
  canAdd: false,
  editable: function () { return false; },
  active: function () { var p = document.getElementById('tab-transactions'); return !!(p && p.classList.contains('active')); },
  columns: [
    { field: 'date', sortable: true, filterType: 'date', label: 'Date',
      // sourceGlyph is silent for the routine case (agent pipeline) and
      // only shows an icon for the exception (a human drafted this via AI
      // chat) — same "quiet unless it's the case worth flagging" idea as
      // the agent-status pill, rather than a column/row that reads the
      // same value on every proposal and carries no information most of
      // the time (docs/UI.md's persistent-status-indicator principle).
      display: function (v, r) { return '<span style="white-space:nowrap" title="' + esc(String(v || '').slice(0, 10)) + '">' + TXN_GLYPH[r.kind] + sourceGlyph(r) + FB.util.fmtDateShort(v) + '</span>'; } },
    { field: 'counterparty', sortable: true, filterType: 'text', label: 'Counterparty',
      display: function (v, r) {
        var html = v ? esc(v) : '<span class="pe-ro">—</span>';
        return r.reference ? '<span title="Ref: ' + esc(r.reference) + '">' + html + '</span>' : html;
      } },
    { field: 'description', sortable: true, filterType: 'text', label: 'Description',
      display: function (v) { return v ? esc(v) : '<span class="pe-ro">—</span>'; } },
    { field: 'amount', sortable: true, align: 'right', filterType: 'amount', label: 'Amount',
      display: function (v, r) { return fmtAmt(r.amount); } },
    // Dedicated, sortable/filterable Currency column — the Payables
    // standard (2026-09-11), replacing the inline amount-cell suffix this
    // used to be. Collapses via .single-ccy when every visible row shares
    // one currency (_refreshTxnCcyVisibility below), same "conditional
    // column" principle as before, just implemented as a real column
    // instead of folding the value into Amount's own text.
    { field: 'currency', sortable: true, filterType: 'list', label: 'CCY',
      display: function (v) { return '<span class="pe-ro">' + esc(v || BASE_CURRENCY) + '</span>'; } },
    { field: 'status', sortable: true, filterType: 'list', label: 'Status',
      display: function (v, r) { return statusBadge(r); } },
    // filterType: null — opts out of fb-list.js's own default (every column
    // gets a 'text' filter unless it's type:'checkbox' or opts out
    // explicitly). _doc isn't a real field on the row (underlagBadge
    // computes it from attachment_count/warnings), so the auto-added
    // filter button would search a value that's always undefined — a
    // dead control, not a working one. Same reasoning applies to
    // Partners' _source column below.
    { field: '_doc', label: '', filterType: null, display: function (v, r) { return underlagBadge(r); } },
  ],
  list: { fetch: fetchTxnRows, map: function (row) { return row; } },
  onLoaded: function (saved) { _refreshTxnCcyVisibility(saved); },
  onChrome: function () { _applyTxnCcyVisibility(); },
  children: function (row) {
    // Matches the mockup exactly (lineRowsHtml): unfold is JUST the line
    // items, no meta row. "Proposed by"/"Rejected by" used to be a separate
    // child row here — created_by is now the parent row's source glyph
    // (silent for the routine agent case), and reviewed_by/review_note
    // are on the Status badge's own tooltip (statusBadge above) — neither
    // needs its own row, and request_id (an idempotency/debug id, not
    // reviewer-facing information) is simply dropped, same as the mockup.
    return (row._lines || []).map(function (l, i) { return lineChild(row, l, i); });
  },
  childRowHtml: function (parent, child) {
    // Mechanical signed convention (2026-09-10, deliberately deviating from
    // the mockup's separate Debit/Credit cells, matching the standard for a
    // multi-account journal-entry line list — same as SAP's own FI amount
    // sign derived from its S/H debit-credit indicator): debit is positive,
    // credit is negative, regardless of account type. This only holds
    // scoped to one full entry's lines together; it would be wrong for a
    // single account's own running ledger, where "positive" instead means
    // "moved in that account's normal-balance direction."
    var signed = Number(child.debit || 0) - Number(child.credit || 0);
    return '<td></td>'
      + '<td>' + esc(child.account_code) + '</td>'
      + '<td>' + esc(child.description) + '</td>'
      + '<td class="amt">' + fmtAmt(signed) + '</td>'
      // colspan 3 covers Currency+Status+source-doc (was 2, covering just
      // Status+source-doc, before the Currency column was added here).
      + '<td colspan="3"></td><td></td>';
  },
  rowVerbs: [
    { key: 'y', label: 'approve',
      when: function (row) { return row.status === 'proposed'; },
      affordance: function () { return '<a class="chip chip-ok" title="Approve" aria-label="Approve" data-act="verb:y">&#10003;</a>'; },
      run: function (api, row) { reviewTxn(row, 'approve'); } },
    { key: 'x', label: 'reject',
      when: function (row) { return row.status === 'proposed'; },
      affordance: function () { return '<a class="chip chip-cancel" title="Reject" aria-label="Reject" data-act="verb:x">&#10005;</a>'; },
      run: function (api, row) { reviewTxn(row, 'reject'); } },
    // Correct & Resubmit — journal rows only (a rejected bill's fix is just
    // editing it again via payables-bills.js; there is no bill-voucher
    // equivalent of journal-voucher.js's ?correct= mode).
    { key: 'c', label: 'correct & resubmit',
      when: function (row) { return row.kind === 'journal' && row.status === 'rejected'; },
      affordance: function () { return '<a class="chip" title="Correct & Resubmit" aria-label="Correct & Resubmit" data-act="verb:c">&#9998;</a>'; },
      run: function (api, row) { window.location.href = '/' + COMPANY + '/journal/voucher?correct=' + encodeURIComponent(row.proposal_id); } },
    { key: '~', label: 'toggle full/partial settlement',
      when: function (row) { return row.status === 'proposed' && !!row.settlement; },
      affordance: function (row) {
        var mode = row.settlement && row.settlement.mode === 'partial' ? 'Partial' : 'Full';
        var cls = row.settlement && row.settlement.blocked ? 'chip chip-cancel' : 'chip';
        return '<a class="' + cls + '" title="Toggle full/partial settlement" data-act="verb:~">' + mode + '</a>';
      },
      run: function (api, row) {
        postAction('bank.match.toggleSettlement', { proposalId: row.proposal_id, billId: row.settlement.billId })
          .then(function (res) {
            if (!res || res.ok === false || res.error) {
              FB.status.show((res && res.error && res.error.message) || 'Toggle failed', true);
              return;
            }
            FB.status.show('Settlement set to ' + (res.data && res.data.mode === 'partial' ? 'partial' : 'full') + '.', false);
            txnList.load();
          })
          .catch(function (e) { FB.status.show('Toggle failed: ' + (e && e.message || e), true); });
      } }
  ],
  hint: 'Transactions: journal + bill proposals. y approve/post, x reject, c correct & resubmit a rejected journal entry, Enter unfolds lines. The Status column filter (≡) shows rejected rows — hidden by default.'
});
// Default view: hide rejected rows (the "graveyard" doctrine journal
// proposals already had) — same mechanism accounting.js uses to deep-link
// a pre-filtered column (applyFilterExpr's field:value qualifier grammar).
txnList.load();
txnList.applyFilterExpr('status:proposed');

// ── Partners tab — flat, single-row inline decision (2026-09-09 follow-up) ──
// Every field editable directly on the row, no unfold: Vendor/Customer/
// accounts/tax code are plain inputs (outside FB.list's own dirty-tracking,
// same idiom payables-bills.js's FB.dropdown-wired cells use), read live at
// Approve time — matches the finalized mockup. The Duplicate column is
// actionable when the fuzzy hit is against an EXISTING partner
// (duplicateBadge below, partner.proposal.alias backend action, both added
// 2026-09-09) — a hit against another pending proposal stays an
// informational badge, since neither side is a real partner yet to alias to.
function mapPartnerItem(it) {
  return {
    _key: 'partner:' + it.payload_ref, _kind: 'partner',
    proposal_id: it.payload_ref,
    type: it.type,
    name: it.counterparty || it.reference || '',
    status: it.status,
    created_by: it.created_by || '',
    duplicate_warning: it.duplicate_warning || null,
    is_vendor: it.is_vendor !== false,
    is_customer: it.is_customer === true,
    default_expense_account: it.default_expense_account || '',
    default_ap_account: it.default_ap_account || '',
    suggested_vat_code: it.suggested_vat_code || '',
    source_proposal_id: it.source_proposal_id || null,
    source_bill_id: it.source_bill_id || null,
  };
}
function fetchPartnerRows() {
  return postAction('inbox.list', { status: 'partners', limit: 100 }).then(function (res) {
    var items = (res && res.data && Array.isArray(res.data.items)) ? res.data.items : [];
    updateTabCount('partners', items.length);
    return items.map(mapPartnerItem);
  });
}

// Account/tax-code source lists (fetched once) and the FB.dropdown wiring
// for the Exp/AP/Tax inputs — same endpoints and code-only-value convention
// payables-bills.js's own FB.dropdown cells already use (its dropdowns
// leave input.value as the bare code; the name rides as this row's
// tooltip instead, closing the "which account IS 7010" gap that prompted
// this rebuild in the first place).
var partnerAccountsList = [], partnerVatCodes = [];
function loadPartnerAccounts() {
  if (partnerAccountsList.length) return Promise.resolve();
  return fetch('/api/' + COMPANY + '/accounts').then(function (r) { return r.json(); })
    .then(function (rows) { partnerAccountsList = Array.isArray(rows) ? rows : []; })
    .catch(function () {});
}
function loadPartnerVatCodes() {
  if (!VAT_ON || partnerVatCodes.length) return Promise.resolve();
  return fetch('/api/' + COMPANY + '/vat-codes').then(function (r) { return r.json(); })
    .then(function (rows) { partnerVatCodes = Array.isArray(rows) ? rows.filter(function (v) { return v.is_active !== false; }) : []; })
    .catch(function () {});
}
loadPartnerAccounts();
loadPartnerVatCodes();

function codeTooltip(code, list, codeKey, nameKey) {
  if (!code) return '';
  var m = list.filter(function (a) { return a[codeKey] === code; })[0];
  return m ? code + ' — ' + (m[nameKey] || '') : code;
}
function wireCodeInput(input, list, codeKey, nameKey) {
  input.title = codeTooltip(input.value.trim(), list, codeKey, nameKey);
  if (!window.FB || !FB.dropdown) return;
  FB.dropdown.attach(input, {
    minWidth: 240,
    source: function (q) {
      q = (q || '').trim().toLowerCase();
      return list.filter(function (a) {
        if (!q) return true;
        return (a[codeKey] || '').toLowerCase().indexOf(q) >= 0 || (a[nameKey] || '').toLowerCase().indexOf(q) >= 0;
      }).map(function (a) { return { primary: a[codeKey], secondary: a[nameKey] || '', data: a }; });
    },
    onPick: function (item, inp) {
      inp.value = item.data[codeKey];
      inp.title = item.data[codeKey] + ' — ' + (item.data[nameKey] || '');
    }
  });
  input.addEventListener('blur', function () { input.title = codeTooltip(input.value.trim(), list, codeKey, nameKey); });
}
function wirePartnerInputs() {
  document.querySelectorAll('#partners-tbody .pf-exp, #partners-tbody .pf-ap').forEach(function (el) {
    wireCodeInput(el, partnerAccountsList, 'account_code', 'account_name');
  });
  if (VAT_ON) {
    document.querySelectorAll('#partners-tbody .pf-vat').forEach(function (el) {
      wireCodeInput(el, partnerVatCodes, 'vat_code', 'description');
    });
  }
}

function partnerSourceHtml(row) {
  if (row.source_bill_id) return '<a class="source-link" href="/' + COMPANY + '/bill/' + encodeURIComponent(row.source_bill_id) + '">bill ↗</a>';
  if (row.source_proposal_id) return '<span class="pe-ro" title="Journal proposal ' + esc(row.source_proposal_id) + ' — no detail page yet">journal proposal</span>';
  return '<span class="pe-ro">—</span>';
}

// Reads the row's LIVE input values (not the stale ones the row was loaded
// with) at Approve time — the reviewer may have just corrected them.
function reviewPartner(row, verdict) {
  var approve = verdict === 'approve';
  var idemKey = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('rev-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  var inFlight = false;
  var tr = document.querySelector('#partners-tbody tr[data-key="' + row._key + '"]');
  FB.modal.open({
    title: (approve ? 'Approve' : 'Reject') + ' partner proposal',
    body: '<div style="font-size:0.8125rem;color:var(--text);line-height:1.7">'
      + '<div><b>' + esc(row.name) + '</b></div>'
      + '<div style="margin-top:6px;color:var(--text-muted);font-size:0.75rem">Proposed by ' + esc(row.created_by || '?') + '</div>'
      + '</div>',
    buttons: [
      { label: approve ? 'Approve' : 'Reject', primary: approve, danger: !approve,
        requiresConfirm: true, key: 'Enter', hint: approve ? 'approve' : 'reject',
        onClick: function (mapi) {
          if (inFlight) return; inFlight = true;
          var body = { proposalId: row.proposal_id };
          if (approve && tr) {
            body.isVendor = !!tr.querySelector('.pf-vendor').checked;
            body.isCustomer = !!tr.querySelector('.pf-customer').checked;
            body.defaultExpenseAccount = tr.querySelector('.pf-exp').value.trim() || null;
            body.defaultApAccount = tr.querySelector('.pf-ap').value.trim() || null;
            var vatInput = tr.querySelector('.pf-vat');
            if (vatInput) body.suggestedVatCode = vatInput.value.trim() || null;
          }
          postAction('partner.proposal.' + verdict, body, idemKey)
            .then(function (res) {
              if (!res || res.ok === false || res.error) {
                inFlight = false;
                mapi.error((res && res.error && res.error.message) || 'Request failed'); return;
              }
              mapi.close();
              FB.status.show(approve ? 'Approved — added to partners' : 'Proposal rejected', false);
              window.dispatchEvent(new Event('fb:queue-changed'));
              partnersList.load();
            })
            .catch(function (e) { inFlight = false; mapi.error(e.message); });
        } },
      { label: 'Cancel', onClick: function (mapi) { mapi.close(); } }
    ],
    onCancel: function () {}
  });
}
var partnersList = FB.list.create({
  keysId: 'inbox-partners',
  tbody: 'partners-tbody',
  companyId: function () { return COMPANY; },
  tree: false,
  canAdd: false,
  editable: function () { return false; },
  active: function () { var p = document.getElementById('tab-partners'); return !!(p && p.classList.contains('active')); },
  columns: (function () {
    var cols = [
      { field: 'name', sortable: true, filterType: 'text', label: 'Name', display: function (v) { return '🤝 <b>' + esc(v) + '</b>'; } },
      { field: 'is_vendor', align: 'center', sortable: true, filterType: 'list', label: 'Vendor',
        display: function (v, r) { return '<input type="checkbox" class="pf-vendor"' + (r.is_vendor ? ' checked' : '') + '>'; } },
      { field: 'is_customer', align: 'center', sortable: true, filterType: 'list', label: 'Customer',
        display: function (v, r) { return '<input type="checkbox" class="pf-customer"' + (r.is_customer ? ' checked' : '') + '>'; } },
      { field: 'default_expense_account', sortable: true, filterType: 'text', label: 'Exp account',
        display: function (v) { return '<input type="text" class="pf-exp" value="' + esc(v) + '">'; } },
      { field: 'default_ap_account', sortable: true, filterType: 'text', label: 'AP account',
        display: function (v) { return '<input type="text" class="pf-ap" value="' + esc(v) + '">'; } },
    ];
    if (VAT_ON) {
      cols.push({ field: 'suggested_vat_code', sortable: true, filterType: 'text', label: 'Tax code',
        display: function (v) { return '<input type="text" class="pf-vat" value="' + esc(v) + '">'; } });
    }
    cols.push({ field: '_source', label: 'Source', filterType: null, display: function (v, r) { return partnerSourceHtml(r); } });
    cols.push({ field: 'duplicate_warning', sortable: true, filterType: 'text', label: 'Duplicate', display: function (v, r) { return duplicateBadge(r) || '<span class="pe-ro">—</span>'; } });
    return cols;
  })(),
  list: { fetch: fetchPartnerRows, map: function (row) { return row; } },
  rowVerbs: [
    { key: 'y', label: 'approve',
      when: function (row) { return row.status === 'proposed'; },
      affordance: function () { return '<a class="chip chip-ok" title="Approve" aria-label="Approve" data-act="verb:y">&#10003;</a>'; },
      run: function (api, row) { reviewPartner(row, 'approve'); } },
    { key: 'x', label: 'reject',
      when: function (row) { return row.status === 'proposed'; },
      affordance: function () { return '<a class="chip chip-cancel" title="Reject" aria-label="Reject" data-act="verb:x">&#10005;</a>'; },
      run: function (api, row) { reviewPartner(row, 'reject'); } },
  ],
  onLoaded: function () {
    wirePartnerInputs();
  },
  hint: 'Partners: agent-proposed vendors/customers, edit any field then approve. y approve, x reject.'
});

// ── New Rule tab (mapping_suggestion) — real columns (2026-09-09) ────────
// The mockup never actually designed this tab's columns (it was always the
// empty-state placeholder there), so there was no mockup to port to — these
// are the fields mapping_suggestions actually has (description_pattern,
// suggested_account, suggested_vat_code, source_proposal_id), previously
// fetched server-side but silently dropped before reaching the item (same
// class of gap as queryInputRejections' rejected_lines, fixed in inbox.js
// alongside this).
function mapSuggestionItem(it) {
  return {
    _key: 'sugg:' + it.payload_ref, _kind: 'suggestion',
    suggestion_id: it.payload_ref,
    date: it.date,
    pattern: it.description || it.reference || '',
    suggested_account: it.suggested_account || '',
    suggested_vat_code: it.suggested_vat_code || '',
    source_proposal_id: it.source_proposal_id || null,
    status: it.status,
    created_by: it.created_by || '',
  };
}
function fetchSuggestionRows() {
  return postAction('inbox.list', { status: 'suggestions', limit: 100 }).then(function (res) {
    var items = (res && res.data && Array.isArray(res.data.items)) ? res.data.items : [];
    updateTabCount('newrule', items.length);
    return items.map(mapSuggestionItem);
  });
}
function reviewSuggestion(row, verdict) {
  var approve = verdict === 'approve';
  var idemKey = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('rev-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  var inFlight = false;
  FB.modal.open({
    title: (approve ? 'Approve' : 'Reject') + ' mapping suggestion',
    body: '<div style="font-size:0.8125rem;color:var(--text);line-height:1.7">'
      + '<div>' + esc(row.pattern) + ' → ' + esc(row.suggested_account) + '</div>'
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
              newRuleList.load();
            })
            .catch(function (e) { inFlight = false; mapi.error(e.message); });
        } },
      { label: 'Cancel', onClick: function (mapi) { mapi.close(); } }
    ],
    onCancel: function () {}
  });
}
var newRuleList = FB.list.create({
  keysId: 'inbox-newrule',
  tbody: 'newrule-tbody',
  companyId: function () { return COMPANY; },
  tree: false,
  canAdd: false,
  editable: function () { return false; },
  active: function () { var p = document.getElementById('tab-newrule'); return !!(p && p.classList.contains('active')); },
  columns: (function () {
    var cols = [
      { field: 'date', sortable: true, filterType: 'date', label: 'Date', display: function (v) { return '<span title="' + esc(String(v || '').slice(0, 10)) + '">' + FB.util.fmtDateShort(v) + '</span>'; } },
      { field: 'pattern', sortable: true, filterType: 'text', label: 'Pattern', display: function (v) { return v ? esc(v) : '<span class="pe-ro">—</span>'; } },
      { field: 'suggested_account', sortable: true, filterType: 'text', label: 'Suggested account', display: function (v) { return v ? esc(v) : '<span class="pe-ro">—</span>'; } },
    ];
    if (VAT_ON) {
      cols.push({ field: 'suggested_vat_code', sortable: true, filterType: 'text', label: 'Tax code', display: function (v) { return v ? esc(v) : '<span class="pe-ro">—</span>'; } });
    }
    cols.push({ field: 'created_by', sortable: true, filterType: 'text', label: 'Source', display: function (v, r) {
      var by = v ? 'Suggested by ' + esc(v) : 'Suggested by agent';
      return r.source_proposal_id ? by + ' <span class="pe-ro" title="Journal proposal ' + esc(r.source_proposal_id) + '">↖</span>' : by;
    } });
    return cols;
  })(),
  list: { fetch: fetchSuggestionRows, map: function (row) { return row; } },
  rowVerbs: [
    { key: 'y', label: 'approve',
      when: function (row) { return row.status === 'proposed'; },
      affordance: function () { return '<a class="chip chip-ok" title="Approve" aria-label="Approve" data-act="verb:y">&#10003;</a>'; },
      run: function (api, row) { reviewSuggestion(row, 'approve'); } },
    { key: 'x', label: 'reject',
      when: function (row) { return row.status === 'proposed'; },
      affordance: function () { return '<a class="chip chip-cancel" title="Reject" aria-label="Reject" data-act="verb:x">&#10005;</a>'; },
      run: function (api, row) { reviewSuggestion(row, 'reject'); } },
  ],
  hint: 'New Rule: agent-suggested bank-mapping rules. y approve, x reject.'
});

// ── Failed Input tab (input_rejection only) ──────────────────────────────
function mapRejectionItem(it) {
  return {
    _key: 'rej:' + it.payload_ref, _kind: 'rejection',
    rejection_id: it.payload_ref,
    date: it.date,
    description: it.summary || it.description || '',
    amount: null,
    reason: it.description || it.summary || '',
    created_by: it.created_by || '',
    statement_id: it.statement_id || null,
    rejected_lines: Array.isArray(it.rejected_lines) ? it.rejected_lines : null,
  };
}
function fetchRejectionRows() {
  return postAction('inbox.list', { status: 'rejections', limit: 100 }).then(function (res) {
    var items = (res && res.data && Array.isArray(res.data.items)) ? res.data.items : [];
    updateTabCount('failedinput', items.length);
    return items.map(mapRejectionItem);
  });
}
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
            failedInputList.load();
          }).catch(function (e) { FB.status.show('Discard failed: ' + (e && e.message || e), true); });
        } }
    ]
  });
}
// input_rejection.retry (2026-09-09) — re-queues the ORIGINAL attachment for
// agent reprocessing (the backend re-emits the same attachment.uploaded
// event the agent originally reacted to); there is no line-editor to correct
// the raw data first, so this is a plain re-run — useful when the failure
// was transient (an LLM hiccup, a mapping/CSV-column setting since fixed in
// Settings), not a guarantee. A fresh failure creates a NEW Failed Input row
// the same way any upload does.
function retryRejection(row) {
  FB.modal.open({
    title: 'Retry this rejection?',
    body: 'Re-queues the original file for the agent to process again — useful if the failure was transient (e.g. a mapping setting has since been fixed). A fresh failure will show up as a new row.<br>' + esc(row.description),
    buttons: [
      { label: 'Cancel', onClick: function (api) { api.close(); } },
      { label: 'Retry', primary: true, onClick: function (api) {
          api.close();
          postAction('input_rejection.retry', { rejectionId: row.rejection_id }).then(function (res) {
            if (!res || res.ok === false || res.error) {
              FB.status.show((res && res.error && res.error.message) || 'Retry failed', true); return;
            }
            FB.status.show('Re-queued for the agent.', false);
            failedInputList.load();
          }).catch(function (e) { FB.status.show('Retry failed: ' + (e && e.message || e), true); });
        } }
    ]
  });
}
// Statement-doc link — lazy-fetched on first unfold, same caching idiom as
// fetchUnderlag. statement_id IS the attachment's own attachment_id (per
// agent-loop.js's input_rejection.create call: statement_id: ev.entity_id,
// where ev is the attachment.uploaded EVENT — its entity_id is the
// attachment's primary key), NOT the attachment row's own entity_id column
// (a caller-chosen grouping id at upload time, e.g. Inbox's own upload
// panel generates a fresh random one — unrelated to attachment_id). Found
// while building retry (2026-09-09): this previously queried by
// entityType/entityId and could never match a real agent-created row,
// silently showing "Loading source statement…" forever.
var _stmtCache = {};
function fetchStatementDoc(statementId) {
  if (!statementId || _stmtCache[statementId] !== undefined) return;
  _stmtCache[statementId] = '__pending';
  postAction('attachment.list', { attachmentId: statementId })
    .then(function (res) {
      var atts = (res && Array.isArray(res.data)) ? res.data : [];
      _stmtCache[statementId] = atts[0] || null;
      failedInputList.render();
    })
    .catch(function () { _stmtCache[statementId] = null; failedInputList.render(); });
}
var failedInputList = FB.list.create({
  keysId: 'inbox-failedinput',
  tbody: 'failedinput-tbody',
  companyId: function () { return COMPANY; },
  tree: true,
  canAdd: false,
  editable: function () { return false; },
  active: function () { var p = document.getElementById('tab-failedinput'); return !!(p && p.classList.contains('active')); },
  columns: [
    // No Type column — this tab holds exactly one row kind now, a per-row
    // label repeating the tab's own name was pure duplication. The icon
    // rides the Date column instead, matching Transactions' own convention.
    { field: 'date', sortable: true, filterType: 'date', label: 'Date',
      display: function (v) { return '<span class="type-glyph" title="Failed input">\\uD83D\\uDEAB</span><span title="' + esc(String(v || '').slice(0, 10)) + '">' + FB.util.fmtDateShort(v) + '</span>'; } },
    { field: 'description', sortable: true, filterType: 'text', label: 'Description', display: function (v) { return v ? esc(v) : '<span class="pe-ro">—</span>'; } },
    { field: 'amount', sortable: true, align: 'right', filterType: 'amount', label: 'Amount', display: function () { return ''; } },
    { field: 'reason', sortable: true, filterType: 'text', label: 'Reason', display: function (v) { return v ? '<span class="pe-ro">' + esc(v) + '</span>' : ''; } },
  ],
  list: { fetch: fetchRejectionRows, map: function (row) { return row; } },
  children: function (row) {
    if (!row.rejected_lines || !row.rejected_lines.length) {
      return [{ _key: row._key + ':meta', _childOf: row._key, _meta: 'Flagged by ' + (row.created_by || '?') }];
    }
    if (row.statement_id) fetchStatementDoc(row.statement_id);
    return [{ _key: row._key + ':detail', _childOf: row._key, _detail: row }];
  },
  childRowHtml: function (parent, child) {
    if (child._meta) return '<td colspan="4" class="jrnl-meta">' + esc(child._meta) + '</td>';
    var row = child._detail;
    var stmt = row.statement_id ? _stmtCache[row.statement_id] : null;
    var html = '';
    if (row.statement_id) {
      html += stmt
        ? '<div class="discard-detail-doc">Source: <a href="/api/attachments/' + esc(stmt.attachment_id) + '" target="_blank" class="source-link">' + esc(stmt.filename) + ' \\u2197</a></div>'
        : '<div class="discard-detail-doc pe-ro">Loading source statement\\u2026</div>';
    }
    html += row.rejected_lines.map(function (l) {
      return '<div class="discard-line"><b>Line ' + esc(l.line) + ':</b> <code>' + esc(l.raw) + '</code> — ' + esc(l.reason) + '</div>';
    }).join('');
    return '<td colspan="4" class="jrnl-meta">' + html + '</td>';
  },
  rowVerbs: [
    { key: 'x', label: 'discard',
      when: function () { return true; },
      affordance: function () { return '<a class="chip chip-cancel" title="Discard" aria-label="Discard" data-act="verb:x">&#10005;</a>'; },
      run: function (api, row) { discardRejection(row); } },
    { key: 'r', label: 'retry',
      when: function () { return true; },
      affordance: function () { return '<a class="chip chip-ok" title="Retry" aria-label="Retry" data-act="verb:r">&#8635;</a>'; },
      run: function (api, row) { retryRejection(row); } }
  ],
  hint: 'Failed Input: statement lines that failed to parse. x discard, r retry (re-queue for the agent), Enter unfolds the failed line detail + source statement.'
});

// ── Tab switching + live counts ─────────────────────────────────────────
var INBOX_TABS = ['transactions', 'partners', 'newrule', 'failedinput'];
var tabCounts = { transactions: 0, partners: 0, newrule: 0, failedinput: 0 };
function updateTabCount(tab, n) {
  tabCounts[tab] = n;
  var el = document.getElementById('count-' + tab);
  if (!el) return;
  el.textContent = n > 0 ? String(n) : '';
  el.className = 'tab-count ' + (n > 0 ? 'some' : 'zero');
}
var INBOX_LISTS = { transactions: txnList, partners: partnersList, newrule: newRuleList, failedinput: failedInputList };
function showInboxTab(t) {
  document.querySelectorAll('.tabs .tab').forEach(function (el, i) { el.classList.toggle('active', INBOX_TABS[i] === t); });
  document.querySelectorAll('.tab-panel').forEach(function (el) { el.classList.remove('active'); });
  document.getElementById('tab-' + t).classList.add('active');
  // Reload on every switch (not lazy/cached like accounting.js's tabs) —
  // this is a review queue; a stale approved/rejected row lingering after
  // an action elsewhere is worse than one extra fetch.
  INBOX_LISTS[t].load();
  var hintEl = document.getElementById('sb-hints');
  if (hintEl) INBOX_LISTS[t].renderHints(hintEl);
}

// All four tabs fetch on page load (not lazily on first visit) — the tab
// strip shows every tab's live count up front, so every list needs its
// data whether or not that tab is currently visible.
partnersList.load();
newRuleList.load();
failedInputList.load();
var _initialHintEl = document.getElementById('sb-hints');
if (_initialHintEl) txnList.renderHints(_initialHintEl);

// Deep-link from the topbar's global "+" menu (?upload=1) — same
// read-window.location.search-at-script-time convention bank/settings/
// payables already use for their own ?tab= deep-links (common.js).
if (new URLSearchParams(window.location.search).get('upload')) {
  document.getElementById('inbox-upload-panel').classList.add('open');
}
</script>
${layoutEnd()}
</body>
</html>`;
}

module.exports = { handleInboxPage };
