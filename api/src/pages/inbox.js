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
  #queue-note { margin:0 0 10px; font-size:0.75rem; color:var(--text-muted); }
  /* Tab strip (accounting.js/settings.js's recipe — page-local per those
     precedents, not a shared component). */
  .tabs { display:flex; gap:0; border-bottom:2px solid var(--accent); margin-bottom:20px; }
  .tab { padding:8px 20px; cursor:pointer; font-weight:600; font-size:0.8125rem; color:var(--text-muted); border-bottom:3px solid transparent; margin-bottom:-2px; }
  .tab.active { color:var(--accent); border-bottom-color:var(--accent); }
  .tab-panel { display:none; }
  .tab-panel.active { display:block; }
  .tab-count { display:inline-block; min-width:16px; padding:0 5px; border-radius:20px; font-size:0.6875rem; font-weight:700; margin-left:5px; }
  .tab-count.zero { color:var(--text-faint); }
  .tab-count.some { background:var(--warning-bg); color:var(--warning); }
  /* A4 §4.7 — source-document count badge + no-source-document warning. */
  .ul-badge { display:inline-block; margin-left:6px; padding:1px 7px; border-radius:9px;
    font-size:0.6875rem; font-weight:600; background:var(--info-bg); color:var(--info); white-space:nowrap; }
  .ul-warn  { display:inline-block; margin-left:6px; padding:1px 7px; border-radius:9px;
    font-size:0.6875rem; font-weight:700; background:var(--danger-bg); color:var(--danger); white-space:nowrap;
    border:1px solid var(--danger-border); }
  /* Unfold preview (§4.7): the underlag panel renders as a child row holding
     shared fb-attachments rows (FB.attachments.rowHtml). */
  tr[data-child-of] td.jrnl-att { background:var(--bg); padding:6px 10px; }
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

  <div class="tabs">
    <div class="tab active" onclick="showInboxTab('transactions')">Transactions<span class="tab-count" id="count-transactions"></span></div>
    <div class="tab" onclick="showInboxTab('partners')">Partners<span class="tab-count" id="count-partners"></span></div>
    <div class="tab" onclick="showInboxTab('newrule')">New Rule<span class="tab-count" id="count-newrule"></span></div>
    <div class="tab" onclick="showInboxTab('failedinput')">Failed Input<span class="tab-count" id="count-failedinput"></span></div>
  </div>

  <p id="queue-note"></p>

  <div id="tab-transactions" class="tab-panel active">
    <table class="jrnl-table">
      <thead><tr>
        <th>Date</th><th>Counterparty</th><th>Description</th>
        <th style="text-align:right">Amount</th><th>Status</th><th title="Source documents">&#128206;</th><th>Actions</th>
      </tr></thead>
      <tbody id="txn-tbody"></tbody>
    </table>
  </div>

  <div id="tab-partners" class="tab-panel">
    <table class="jrnl-table">
      <thead><tr>
        <th>Date</th><th>Doc No</th><th>Description</th>
        <th style="text-align:right">Amount</th><th>Source</th><th>Created by</th><th>Status</th><th>Actions</th>
      </tr></thead>
      <tbody id="partners-tbody"></tbody>
    </table>
  </div>

  <div id="tab-newrule" class="tab-panel">
    <table class="jrnl-table">
      <thead><tr>
        <th>Date</th><th>Doc No</th><th>Description</th>
        <th style="text-align:right">Amount</th><th>Source</th><th>Created by</th><th>Status</th><th>Actions</th>
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

function postAction(action, body, idemKey) {
  var headers = { 'Content-Type': 'application/json' };
  if (idemKey) headers['Idempotency-Key'] = idemKey;
  return fetch('/api/action', {
    method: 'POST', headers: headers,
    body: JSON.stringify(Object.assign({ action: action, companyId: COMPANY }, body))
  }).then(function (r) { return r.json(); });
}

// ── Upload (calendar-reminders-documents-spec.md §6) ─────────────────────────
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

// Agent-loop / feed-watcher pipeline status.
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
  return n ? '<span class="amt">' + FB.util.fmtAmt(n) + '</span>' : '';
}
function fmtDate(v) { return esc(String(v || '').slice(0, 10)); }

// row.status is always the DISPLAY vocabulary here ('proposed'/'rejected'/
// 'open') — a bill row's real DB status ('draft') is normalized to
// 'proposed' at mapTxnItem time, so this needs no per-kind branching.
function statusBadge(row) {
  var s = row.status || '';
  if (s === 'proposed') return '<span class="badge badge-warning">Proposed</span>';
  if (s === 'rejected') return '<span class="badge badge-danger" title="' + esc(row.review_note || '') + '">Rejected</span>';
  if (s === 'open') return '<span class="badge badge-danger">Open</span>';
  return '';
}

// A4 §4.7 — folded-row source-document indicator. Only PROPOSED items carry
// it; rejected items show nothing. attachment_count > 0 → "📎 N"; 0 → a
// visible ⚠️ warning icon (R7: warn-not-block).
function underlagBadge(row) {
  if (row.status !== 'proposed') return '';
  var n = Number(row.attachment_count || 0);
  var html = '';
  if (n > 0) {
    html += '<span class="ul-badge" title="' + n + ' source document(s) attached">\\uD83D\\uDCCE ' + n + '</span>';
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
  return html;
}

// issue #226 — folded-row fuzzy-duplicate indicator for partner_proposal.
function duplicateBadge(row) {
  if (!row.duplicate_warning) return '';
  var d = row.duplicate_warning;
  var pct = Math.round((Number(d.similarity) || 0) * 100);
  var kindLabel = d.kind === 'proposal' ? 'another pending proposal' : 'an existing partner';
  return '<span class="ul-warn" title="Possibly a duplicate of ' + esc(d.name) + ' (' + kindLabel + ', ' + pct + '% similar) — review before approving">\\u26A0 possible duplicate</span>';
}

// A4 §4.7 — unfold preview, shared by journal proposals AND bill drafts now
// (entityType distinguishes the two attachment namespaces). Cache key is
// "entityType:entityId" so a journal proposal and a bill never collide.
var _attCache = {};
function fetchUnderlag(entityType, entityId) {
  var key = entityType + ':' + entityId;
  if (_attCache[key] !== undefined) return;
  _attCache[key] = '__pending';
  postAction('attachment.list', { entityType: entityType, entityId: entityId })
    .then(function (res) {
      _attCache[key] = (res && Array.isArray(res.data)) ? res.data : [];
      txnList.render();
    })
    .catch(function () { _attCache[key] = []; txnList.render(); });
}
function underlagPanelHtml(entityType, entityId) {
  var key = entityType + ':' + entityId;
  var cached = _attCache[key];
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
      + '<div><b>Date:</b> ' + fmtDate(row.date) + '</div>'
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
      display: function (v, r) { return '<span style="white-space:nowrap">' + TXN_GLYPH[r.kind] + fmtDate(v) + '</span>'; } },
    { field: 'counterparty', sortable: true, filterType: 'text', label: 'Counterparty',
      display: function (v, r) {
        var html = v ? esc(v) : '<span class="pe-ro">—</span>';
        return r.reference ? '<span title="Ref: ' + esc(r.reference) + '">' + html + '</span>' : html;
      } },
    { field: 'description', filterType: 'text', label: 'Description',
      display: function (v) { return v ? esc(v) : '<span class="pe-ro">—</span>'; } },
    { field: 'amount', sortable: true, align: 'right', filterType: 'amount', label: 'Amount',
      // Currency rides on the amount cell, shown only when it differs from
      // the line's own base — never a separate always-blank column for the
      // common (base-currency) case. FB.list's columns are fixed per
      // instance (no per-render conditional column), so "shown only when
      // needed" happens at the content level here, not the column level.
      display: function (v, r) { return fmtAmt(r.amount) + (r.currency ? ' <span class="pe-ro">' + esc(r.currency) + '</span>' : ''); } },
    { field: 'status', sortable: true, filterType: 'list', label: 'Status',
      display: function (v, r) { return statusBadge(r); } },
    { field: '_doc', label: '', display: function (v, r) { return underlagBadge(r); } },
  ],
  list: { fetch: fetchTxnRows, map: function (row) { return row; } },
  children: function (row) {
    var entityType = row.kind === 'bill' ? 'bill' : 'journal_proposal';
    var entityId = row.kind === 'bill' ? row.bill_id : row.proposal_id;
    var kids = [];
    var meta = row.status === 'rejected'
      ? 'Rejected by ' + (row.reviewed_by || '?') + (row.review_note ? ' — ' + row.review_note : '')
      : 'Proposed by ' + (row.created_by || '?') + (row.request_id ? ' · req ' + row.request_id : '');
    kids.push({ _key: row._key + ':meta', _childOf: row._key, _meta: meta });
    if (row.status === 'proposed') {
      kids.push({ _key: row._key + ':att', _childOf: row._key, _attSection: { entityType: entityType, entityId: entityId } });
      fetchUnderlag(entityType, entityId);
    }
    (row._lines || []).forEach(function (l, i) { kids.push(lineChild(row, l, i)); });
    return kids;
  },
  childRowHtml: function (parent, child) {
    if (child._attSection) return '<td colspan="7" class="jrnl-att">' + underlagPanelHtml(child._attSection.entityType, child._attSection.entityId) + '</td>';
    if (child._meta) return '<td colspan="6" class="jrnl-meta">' + esc(child._meta) + '</td><td></td>';
    return '<td></td>'
      + '<td>' + esc(child.account_code) + '</td>'
      + '<td>' + esc(child.description) + '</td>'
      + '<td class="amt">' + fmtAmt(child.debit) + '</td>'
      + '<td colspan="2"></td><td></td>';
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
  onLoaded: function (saved) {
    if (!document.getElementById('tab-transactions').classList.contains('active')) return;
    var note = document.getElementById('queue-note');
    var proposed = saved.filter(function (r) { return r.status === 'proposed'; });
    var rejected = saved.filter(function (r) { return r.status === 'rejected'; });
    note.textContent = proposed.length === 0
      ? (rejected.length ? 'Nothing to review — ' + rejected.length + ' rejected (Status filter)' : 'Nothing to review — agent-proposed journal entries and bills will appear here')
      : proposed.length + ' proposed transaction' + (proposed.length === 1 ? '' : 's') + ' awaiting review';
  },
  hint: 'Transactions: journal + bill proposals. y approve/post, x reject, c correct & resubmit a rejected journal entry, Enter unfolds lines. The Status column filter (≡) shows rejected rows — hidden by default.'
});
// Default view: hide rejected rows (the "graveyard" doctrine journal
// proposals already had) — same mechanism accounting.js uses to deep-link
// a pre-filtered column (applyFilterExpr's field:value qualifier grammar).
txnList.load();
txnList.applyFilterExpr('status:proposed');

// ── Partners tab (ported as-is; full inline-edit is a separate follow-up) ──
function mapPartnerItem(it) {
  return {
    _key: 'partner:' + it.payload_ref, _kind: 'partner',
    proposal_id: it.payload_ref,
    type: it.type,
    date: it.date, reference: it.reference || '',
    description: it.summary || it.description || '',
    amount: null, currency: '', source: it.source || 'agent',
    counterparty: it.counterparty || '',
    status: it.status,
    created_by: it.created_by || '', request_id: '',
    duplicate_warning: it.duplicate_warning || null,
    is_vendor: it.is_vendor !== false,
    is_customer: it.is_customer === true,
    default_expense_account: it.default_expense_account || '',
    default_ap_account: it.default_ap_account || '',
    suggested_vat_code: it.suggested_vat_code || '',
    evidence: it.evidence || null,
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
  tree: true,
  canAdd: false,
  editable: function () { return false; },
  active: function () { var p = document.getElementById('tab-partners'); return !!(p && p.classList.contains('active')); },
  columns: [
    { field: 'date', filterType: 'date', label: 'Date', display: function (v) { return fmtDate(v); } },
    { field: 'reference', filterType: 'text', label: 'Doc No', display: function (v) { return v ? esc(String(v)) : '<span class="pe-ro">—</span>'; } },
    { field: 'description', filterType: 'text', label: 'Description', display: function (v) { return v ? esc(v) : '<span class="pe-ro">—</span>'; } },
    { field: 'amount', align: 'right', filterType: 'amount', label: 'Amount', display: function (v, r) { return fmtAmt(r.amount); } },
    { field: 'source', filterType: 'list', label: 'Source', display: function (v) { return v ? esc(String(v)) : '<span class="pe-ro">—</span>'; } },
    { field: 'created_by', filterType: 'text', label: 'Created by', display: function (v) { return v ? esc(String(v)) : '<span class="pe-ro">—</span>'; } },
    { field: 'status', filterType: 'list', label: 'Status', display: function (v, r) { return statusBadge(r) + duplicateBadge(r); } },
  ],
  list: { fetch: fetchPartnerRows, map: function (row) { return row; } },
  children: function (row) {
    var partnerMeta = 'Proposed by ' + (row.created_by || '?');
    var roleBits = [];
    if (row.is_vendor) roleBits.push('vendor');
    if (row.is_customer) roleBits.push('customer');
    if (roleBits.length) partnerMeta += ' as ' + roleBits.join(' + ');
    if (row.default_expense_account) partnerMeta += ' — expense ' + row.default_expense_account;
    if (row.default_ap_account) partnerMeta += ' · AP ' + row.default_ap_account;
    if (row.suggested_vat_code) partnerMeta += ' · VAT ' + row.suggested_vat_code;
    if (row.source_bill_id) partnerMeta += ' · from bill ' + row.source_bill_id;
    else if (row.source_proposal_id) partnerMeta += ' · from journal proposal ' + row.source_proposal_id;
    if (row.duplicate_warning) {
      var dw = row.duplicate_warning;
      var dwPct = Math.round((Number(dw.similarity) || 0) * 100);
      partnerMeta += ' — possible duplicate of "' + dw.name + '" (' + dwPct + '% similar)';
    }
    return [{ _key: row._key + ':meta', _childOf: row._key, _meta: partnerMeta }];
  },
  childRowHtml: function (parent, child) { return '<td colspan="7" class="jrnl-meta">' + esc(child._meta) + '</td><td></td>'; },
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
  onLoaded: function (saved) {
    if (document.getElementById('tab-partners').classList.contains('active')) {
      var note = document.getElementById('queue-note');
      note.textContent = saved.length === 0
        ? 'No partner proposals awaiting review'
        : saved.length + ' partner proposal' + (saved.length === 1 ? '' : 's') + ' awaiting review — y approve · x reject';
    }
  },
  hint: 'Partners: agent-proposed vendors/customers. y approve, x reject, Enter unfolds detail.'
});

// ── New Rule tab (mapping_suggestion, ported as-is) ─────────────────────
function mapSuggestionItem(it) {
  return {
    _key: 'sugg:' + it.payload_ref, _kind: 'suggestion',
    suggestion_id: it.payload_ref,
    type: it.type,
    date: it.date, reference: it.reference || '',
    description: it.summary || it.description || '',
    amount: null, currency: '', source: it.source || 'agent',
    status: it.status,
    created_by: it.created_by || '', request_id: '',
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
  tree: true,
  canAdd: false,
  editable: function () { return false; },
  active: function () { var p = document.getElementById('tab-newrule'); return !!(p && p.classList.contains('active')); },
  columns: [
    { field: 'date', filterType: 'date', label: 'Date', display: function (v) { return fmtDate(v); } },
    { field: 'reference', filterType: 'text', label: 'Doc No', display: function (v) { return v ? esc(String(v)) : '<span class="pe-ro">—</span>'; } },
    { field: 'description', filterType: 'text', label: 'Description', display: function (v) { return v ? esc(v) : '<span class="pe-ro">—</span>'; } },
    { field: 'amount', align: 'right', filterType: 'amount', label: 'Amount', display: function () { return ''; } },
    { field: 'source', filterType: 'list', label: 'Source', display: function (v) { return v ? esc(String(v)) : '<span class="pe-ro">—</span>'; } },
    { field: 'created_by', filterType: 'text', label: 'Created by', display: function (v) { return v ? esc(String(v)) : '<span class="pe-ro">—</span>'; } },
    { field: 'status', filterType: 'list', label: 'Status', display: function (v, r) { return statusBadge(r); } },
  ],
  list: { fetch: fetchSuggestionRows, map: function (row) { return row; } },
  children: function (row) {
    return [{ _key: row._key + ':meta', _childOf: row._key, _meta: 'Suggested by ' + (row.created_by || '?') }];
  },
  childRowHtml: function (parent, child) { return '<td colspan="7" class="jrnl-meta">' + esc(child._meta) + '</td><td></td>'; },
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
  onLoaded: function (saved) {
    if (document.getElementById('tab-newrule').classList.contains('active')) {
      var note = document.getElementById('queue-note');
      note.textContent = saved.length === 0
        ? 'No mapping suggestions awaiting review'
        : saved.length + ' mapping suggestion' + (saved.length === 1 ? '' : 's') + ' awaiting review — y approve · x reject';
    }
  },
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
// Statement-doc link — lazy-fetched on first unfold, same caching idiom as
// fetchUnderlag (statement_id IS the attachment/entity id, per
// input_rejections' schema comment).
var _stmtCache = {};
function fetchStatementDoc(statementId) {
  if (!statementId || _stmtCache[statementId] !== undefined) return;
  _stmtCache[statementId] = '__pending';
  postAction('attachment.list', { entityType: 'bank_statement', entityId: statementId })
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
    { field: 'date', filterType: 'date', label: 'Date',
      display: function (v) { return '<span class="type-glyph" title="Failed input">\\uD83D\\uDEAB</span>' + fmtDate(v); } },
    { field: 'description', filterType: 'text', label: 'Description', display: function (v) { return v ? esc(v) : '<span class="pe-ro">—</span>'; } },
    { field: 'amount', align: 'right', filterType: 'amount', label: 'Amount', display: function () { return ''; } },
    { field: 'reason', filterType: 'text', label: 'Reason', display: function (v) { return v ? '<span class="pe-ro">' + esc(v) + '</span>' : ''; } },
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
    { key: 'r', label: 'retry (not yet built)',
      when: function () { return true; },
      affordance: function () { return '<span class="chip chip-disabled" title="Retry: correct the data + re-run — not yet built" aria-label="Retry (not yet built)">&#8635;</span>'; },
      run: function () { FB.status.show('Retry is not built yet — discard (x) and re-submit corrected data instead.', true); } }
  ],
  onLoaded: function (saved) {
    if (document.getElementById('tab-failedinput').classList.contains('active')) {
      var note = document.getElementById('queue-note');
      note.textContent = saved.length === 0
        ? 'No failed input'
        : saved.length + ' input rejection' + (saved.length === 1 ? '' : 's') + ' — d discard (r retry not yet built)';
    }
  },
  hint: 'Failed Input: statement lines that failed to parse. x discard, Enter unfolds the failed line detail + source statement.'
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
  // an action elsewhere is worse than one extra fetch. Each list's own
  // onLoaded repopulates #queue-note once its own tab is confirmed active.
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
</script>
${layoutEnd()}
</body>
</html>`;
}

module.exports = { handleInboxPage };
