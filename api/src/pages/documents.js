'use strict';
/**
 * freeBooks — Documents page (calendar-reminders-documents-spec.md §5)
 *
 * A single, strictly DB-driven registry of every attachment in the system —
 * bill/journal/journal_proposal attachments plus standalone uploads
 * (entityType:'document') — never built from scanning the attachments
 * folder on disk (§5.3/§5.5). No link to/from Calendar or Reminders
 * (explicitly rejected during ideation — the two surfaces only share a
 * Period column for filtering, never a navigation link).
 *
 * Columns: ID · Type · Period · Date uploaded (§5.2). System-linked rows are
 * read-only here (view + go-to-source only); standalone uploads can be
 * deleted and re-uploaded, never edited in place (§0.4 — no attribute
 * editing was designed, deliberately).
 *
 * "Go to source" (§5.4) is a small local resolver, not yet the shared
 * nav-registry.js extension the spec names as the natural long-term home —
 * flagged there as new structure to build, not something to invent twice.
 * It's also honest about a real gap: there's no per-batch journal detail
 * route today (the old /:company/journal page was dissolved into the Books
 * "Transaction Register" report, §reports.js), so a 'journal' row links to
 * that report, not a scrolled-to-the-batch view; 'journal_proposal' rows
 * (still pending review, not yet posted) have no addressable detail page at
 * all and get no source link.
 */

const { commonStyle, navBar, layoutEnd } = require('./common');

async function handleDocumentsPage(req, res) {
  const { company } = req.params;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildDocumentsPage(company));
}

function buildDocumentsPage(company) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Documents — freeBooks</title>
${commonStyle()}
<style>
  table.edit-table { width:100%; border-collapse:collapse; font-size:0.8125rem; }
  table.edit-table th { text-align:left; font-size:0.75rem; text-transform:uppercase; color:var(--text-muted); border-bottom:1px solid var(--border); padding:6px 6px; white-space:nowrap; }
  table.edit-table td { padding:4px 6px; border-bottom:1px solid var(--border); vertical-align:top; }
  .row-actions { white-space:nowrap; text-align:right; }
  /* .fb-tag base (cursor/padding/border/hover) is the shared component (common.css) */
  a.fb-tag { display:inline-block; color:var(--accent); margin-left:6px; }
  a.fb-tag:first-child { margin-left:0; }
  .pe-ro { color:var(--text-muted); }
  .doc-id-main { color:var(--text); }
  .doc-id-sub { color:var(--text-muted); font-size:0.6875rem; }
  .doc-id-main a { color:var(--info); text-decoration:none; }
  .doc-id-main a:hover { text-decoration:underline; }
  .doc-type-badge { display:inline-block; padding:1px 8px; border-radius:9px; font-size:0.6875rem; font-weight:600; text-transform:uppercase; letter-spacing:.02em; background:var(--chip-bg); color:var(--chip-text); }
  .doc-missing { color:var(--danger); font-weight:600; }
  .filter-row { display:flex; gap:12px; margin-bottom:16px; align-items:center; }
  .filter-row select { padding:4px 8px; border:1px solid var(--border); border-radius:3px; font-size:0.8125rem; }
  #upload-panel { display:none; margin-bottom:20px; padding:12px; border:1px solid var(--border); border-radius:4px; background:var(--bg); }
  #upload-panel.open { display:block; }
  #upload-panel input, #upload-panel select { padding:4px 8px; border:1px solid var(--border); border-radius:3px; font-size:0.8125rem; margin-right:8px; }
</style>
</head>
<body>${navBar(company, 'documents')}
<div class="page page-wide">
  <div class="header"><h1>📄 Documents</h1></div>

  <div class="filter-row">
    <a class="fb-tag" data-act="upload-toggle">+ Upload document</a>
    <label>Type <select id="doc-type-filter"><option value="">All</option></select></label>
    <label>Period <select id="doc-period-filter"><option value="">All</option></select></label>
  </div>

  <div id="upload-panel">
    <input type="file" id="doc-upload-file">
    <input type="text" id="doc-upload-type" placeholder="Type (e.g. Annual Report)" list="doc-type-options">
    <datalist id="doc-type-options"></datalist>
    <select id="doc-upload-period"><option value="">No period</option></select>
    <a class="fb-tag" data-act="upload-save">Save</a>
    <a class="fb-tag" data-act="upload-cancel">Cancel</a>
  </div>

  <table class="edit-table" id="documents-table">
    <thead><tr><th>ID</th><th>Type</th><th>Period</th><th>Date Uploaded</th><th></th></tr></thead>
    <tbody id="documents-body"></tbody>
  </table>
</div>
${layoutEnd()}
<script>
var COMPANY = ${JSON.stringify(company)};

function postAction(action, body, idemKey) {
  var headers = { 'Content-Type': 'application/json' };
  if (idemKey) headers['Idempotency-Key'] = idemKey;
  return fetch('/api/action', { method: 'POST', headers: headers,
    body: JSON.stringify(Object.assign({ action: action, companyId: COMPANY }, body)) })
    .then(function (r) { return r.json(); });
}

// entity_type → route resolver (see file header — a local stand-in for the
// shared nav-registry.js extension the spec names, not built yet). The
// clickable doc number (below) already covers 'journal' rows exactly the
// way the GL/Journal Line Listing/Voucher Register reports do — this is
// only for destinations the doc number link doesn't reach.
function sourceHref(row) {
  if (row.entity_type === 'bill') return '/' + COMPANY + '/bill/' + row.entity_id;
  return null; // journal (covered by the doc number link), journal_proposal (not yet posted, no detail page), document, filing (legacy)
}

var allDocs = [];

function loadDocuments() {
  var tb = document.getElementById('documents-body');
  Promise.all([
    postAction('attachment.list', {}),
    postAction('period.list', {}),
  ]).then(function (results) {
    var res = results[0];
    var periodsRes = results[1];
    allDocs = (res && res.data) || res || [];
    var periods = (periodsRes && periodsRes.data) || periodsRes || [];
    populateFilters(allDocs, periods);
    populatePeriodSelect(document.getElementById('doc-upload-period'), periods);
    renderDocuments();
  }).catch(function (e) {
    tb.innerHTML = '<tr><td colspan="5" class="pe-ro">Failed to load: ' + esc(e && e.message || e) + '</td></tr>';
  });
}

function populateFilters(docs, periods) {
  var types = Array.from(new Set(docs.map(function (d) { return d.entity_type === 'document' ? (d.doc_type || 'Other') : d.entity_type; }).filter(Boolean))).sort();
  var typeSel = document.getElementById('doc-type-filter');
  typeSel.innerHTML = '<option value="">All</option>' + types.map(function (t) { return '<option value="' + esc(t) + '">' + esc(t) + '</option>'; }).join('');
  var periodSel = document.getElementById('doc-period-filter');
  periodSel.innerHTML = '<option value="">All</option>' + periods.map(function (p) {
    var id = p.period_id || p.period_name;
    return '<option value="' + esc(id) + '">' + esc(id) + '</option>';
  }).join('');
  var typeOptions = document.getElementById('doc-type-options');
  typeOptions.innerHTML = types.map(function (t) { return '<option value="' + esc(t) + '">'; }).join('');
}

function populatePeriodSelect(sel, periods) {
  sel.innerHTML = '<option value="">No period</option>' + periods.map(function (p) {
    var id = p.period_id || p.period_name;
    return '<option value="' + esc(id) + '">' + esc(id) + '</option>';
  }).join('');
}

function renderDocuments() {
  var tb = document.getElementById('documents-body');
  var typeFilter = document.getElementById('doc-type-filter').value;
  var periodFilter = document.getElementById('doc-period-filter').value;
  var rows = allDocs.filter(function (d) {
    var type = d.entity_type === 'document' ? (d.doc_type || 'Other') : d.entity_type;
    if (typeFilter && type !== typeFilter) return false;
    if (periodFilter && d.period_id !== periodFilter) return false;
    return true;
  });
  tb.innerHTML = rows.map(function (d) {
    var isUpload = d.entity_type === 'document';
    // Bank statements (feed-watcher.js) have no owning ledger record to name
    // them by — one file fans out into many separate journal proposals, so
    // there's no docnr or single meaningful id, only the filename itself.
    var namedByFilename = isUpload || d.entity_type === 'bank_statement';
    var idMain;
    if (namedByFilename) {
      idMain = esc(d.filename);
    } else if (d.docnr) {
      // The same sequential GL doc number shown clickably in the GL/Journal
      // Line Listing/Voucher Register reports — same click target too.
      // No &from= here deliberately: the voucher view's Quit button builds
      // its return URL as /journal?t=<from>, a Journal-tab id namespace
      // Documents isn't part of — omitting it falls back to the company
      // root, the same safe default the view already uses when from is unset.
      idMain = '<a href="/' + COMPANY + '/journal/voucher?batch=' + esc(d.docnr_batch_id) + '">' + esc(d.docnr) + '</a>';
    } else {
      // Not yet posted — no doc number exists yet, and a raw id (a UUID) is
      // meaningless to a human. Say what state it's actually in instead.
      var pendingLabel = d.entity_type === 'bill' ? 'Pending Bill'
        : d.entity_type === 'journal_proposal' ? 'Pending Inbox'
        : 'Pending';
      idMain = '<span class="pe-ro">' + esc(pendingLabel) + '</span>';
    }
    var idCell = namedByFilename
      ? '<div class="doc-id-main">' + idMain + '</div>'
      : '<div class="doc-id-main">' + idMain + '</div><div class="doc-id-sub">' + esc(d.filename) + '</div>';
    var typeLabel = isUpload ? (d.doc_type || 'Other') : d.entity_type;
    var missing = d.missing_since ? ' <span class="doc-missing" title="File missing from storage since ' + esc(String(d.missing_since).slice(0, 10)) + '">missing</span>' : '';
    var href = sourceHref(d);
    var actions = '<a class="fb-tag" href="/api/attachments/' + esc(d.attachment_id) + '" target="_blank" rel="noopener">Open</a>';
    if (href) actions += ' <a class="fb-tag" href="' + esc(href) + '">Go to source</a>';
    // Standalone uploads can always be deleted; system-linked rows (bill/
    // invoice/JV/filing attachments) only once their file is gone — that's
    // the sole way to clear a permanently-missing attachment, since there's
    // no replace/reupload path and the row would otherwise re-raise the
    // attachment-missing notification forever (attachment-integrity-scanner.js).
    if (isUpload || d.missing_since) actions += ' <a class="fb-tag" data-act="doc-delete" data-id="' + esc(d.attachment_id) + '" data-name="' + esc(d.filename) + '" data-missing="' + (d.missing_since ? '1' : '') + '">Delete</a>';
    return '<tr>'
      + '<td>' + idCell + '</td>'
      + '<td><span class="doc-type-badge">' + esc(typeLabel) + '</span>' + missing + '</td>'
      + '<td>' + esc(d.period_id || '') + (d.period_id ? '' : '<span class="pe-ro">—</span>') + '</td>'
      + '<td>' + esc(String(d.uploaded_at || '').slice(0, 10)) + '</td>'
      + '<td class="row-actions">' + actions + '</td>'
      + '</tr>';
  }).join('') || '<tr><td colspan="5" class="pe-ro">No documents.</td></tr>';
}

document.getElementById('doc-type-filter').addEventListener('change', renderDocuments);
document.getElementById('doc-period-filter').addEventListener('change', renderDocuments);

// Delete — standalone uploads any time, system-linked rows (bill/invoice/JV/
// filing attachments) only once their file is already missing from storage,
// since that's the only way to clear a permanently-missing attachment.
document.addEventListener('click', function (e) {
  var chip = e.target.closest('[data-act="doc-delete"]');
  if (!chip) return;
  e.preventDefault(); e.stopPropagation();
  var msg = chip.dataset.missing
    ? 'This file is already missing from storage. Remove its record from "' + chip.dataset.name + '"?'
    : 'Delete "' + chip.dataset.name + '"?';
  FB.modal.open({
    title: msg,
    buttons: [
      { label: 'Cancel', onClick: function (api) { api.close(); } },
      { label: chip.dataset.missing ? 'Remove record' : 'Delete', danger: true, onClick: function (api) {
          api.close();
          postAction('attachment.delete', { attachmentId: chip.dataset.id }).then(function () {
            FB.status.show('Deleted.');
            loadDocuments();
          }).catch(function (err) { FB.status.show('Delete failed: ' + (err && err.message || err), true); });
        } }
    ]
  });
});

// Upload panel toggle
document.addEventListener('click', function (e) {
  if (e.target.closest('[data-act="upload-toggle"]')) {
    document.getElementById('upload-panel').classList.toggle('open');
  }
  if (e.target.closest('[data-act="upload-cancel"]')) {
    document.getElementById('upload-panel').classList.remove('open');
  }
});

document.addEventListener('click', function (e) {
  if (!e.target.closest('[data-act="upload-save"]')) return;
  var fileInput = document.getElementById('doc-upload-file');
  var file = fileInput.files[0];
  var docType = document.getElementById('doc-upload-type').value.trim();
  var periodId = document.getElementById('doc-upload-period').value;
  if (!file) { FB.status.show('Choose a file first.', true); return; }
  if (!docType) { FB.status.show('Type is required.', true); return; }
  var reader = new FileReader();
  reader.onload = function () {
    var b64 = reader.result.split(',')[1];
    var entityId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(36).slice(2));
    postAction('attachment.upload', {
      entityType: 'document', entityId: entityId,
      filename: file.name, contentBase64: b64, contentType: file.type || 'application/octet-stream',
      docType: docType, periodId: periodId || null,
    }).then(function () {
      FB.status.show('Uploaded ' + file.name + '.');
      document.getElementById('upload-panel').classList.remove('open');
      fileInput.value = '';
      document.getElementById('doc-upload-type').value = '';
      loadDocuments();
    }).catch(function (err) { FB.status.show('Upload failed: ' + (err && err.message || err), true); });
  };
  reader.readAsDataURL(file);
});

loadDocuments();
</script>
</body>
</html>`;
}

module.exports = { handleDocumentsPage };
