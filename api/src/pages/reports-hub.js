'use strict';
const { navBar, layoutEnd, commonStyle } = require('./common');
const { REPORT_REGISTRY, reportsByPage } = require('../report-registry');
const { queryPositional } = require('../db');
const { packIntegration } = require('../jurisdiction-packs');

/**
 * Shared page builder for the Statements and Books hubs.
 *
 * The two hubs are structurally identical — they differ only in which slice of
 * the report registry they expose (page='statements' vs page='books'), the
 * page title, the navbar active key, and whether the SIE export affordance
 * is rendered (Books only — SIE is a Swedish statutory audit export).
 *
 * @param {object}   req
 * @param {object}   res
 * @param {object}   opts
 * @param {string}   opts.pageKey    'statements' | 'books' — selects reportsByPage()
 * @param {string}   opts.pageTitle  Human title, e.g. 'Statements'
 * @param {string}   opts.activeKey  navBar active key, e.g. 'statements' | 'books'
 */
async function buildHubPage(req, res, opts) {
  const { pageKey, pageTitle, activeKey } = opts;
  const company = req.params.company;

  // SIE is a Swedish statutory format — the export affordance only renders
  // on the Books page (it's an audit export), and only when the company's
  // jurisdiction pack declares integrations.sie.export
  // (the /report?type=sie endpoint enforces the same gate server-side).
  const sieExportEnabled = (pageKey === 'books') ? await isSieExportEnabled(company) : false;

  // Dropdown + client behavior driven by the report registry
  // (docs/reports-dashboard-spec.md §4) — add a report there, not here.
  // The page IS the category now, so the dropdown is a flat list (no optgroups).
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const pageReports = reportsByPage(pageKey);
  const typeOptions = pageReports.map(r =>
    `<option value="${r.id}">${esc(r.label)}</option>`
  ).join('\n      ');
  const rptMeta = {};
  for (const r of pageReports) rptMeta[r.id] = { multiperiod: !!r.multiperiod, needsStart: !!r.needsStart };

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(pageTitle)} \u2014 freeBooks</title>
${commonStyle()}
</head>
<body>${navBar(company, activeKey)}
<div class="page" style="display:flex; flex-direction:column; height:100%; padding:0; overflow:hidden; max-width:none;">
  <div class="header" style="flex-shrink:0; padding:2.25rem 3rem 0;">
    <h1>\u{1F4C8} ${esc(pageTitle)}</h1>
  </div>

  <div class="tb-controls-row" style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:0.75rem 3rem; border-bottom:1px solid var(--border,#e8e8e8); flex-shrink:0;">
    <select id="rpt-type" class="tb-select" style="min-width:168px" onchange="fbOnTypeChange()">
      <option value="" disabled selected>Select report\u2026</option>
      ${typeOptions}
    </select>
    <div class="tb-divider"></div>
    <button class="tb-toggle-btn" id="rpt-mom" onclick="fbToggleComparison('mom')" title="Month-over-month" style="margin-left:8px">MoM</button>
    <button class="tb-toggle-btn" id="rpt-yoy" onclick="fbToggleComparison('yoy')" title="Year-over-year">YoY</button>
    <div style="position:relative;margin-left:auto">
      <button class="tb-icon-btn" id="rpt-dl-btn" onclick="fbToggleDownload(event)" title="Download report">\u2B07</button>
      <div id="rpt-dl-dd" style="display:none;position:absolute;right:0;top:calc(100% + 4px);background:var(--surface);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.12);z-index:300;min-width:140px;padding:4px 0">
        <button onclick="fbExportPDF()" style="display:block;width:100%;padding:9px 16px;background:none;border:none;text-align:left;cursor:pointer;font-size:0.875rem;color:var(--text)">\uD83D\uDDA8 Print / PDF</button>
        <button onclick="fbExportCSV()" style="display:block;width:100%;padding:9px 16px;background:none;border:none;text-align:left;cursor:pointer;font-size:0.875rem;color:var(--text)">\u2B07 CSV</button>
        ${sieExportEnabled ? '<button onclick="fbExportSIE()" title="SIE 4 ledger export (Gredor/Bolagsverket)" style="display:block;width:100%;padding:9px 16px;background:none;border:none;text-align:left;cursor:pointer;font-size:0.875rem;color:var(--text)">\u2B07 SIE</button>' : ''}
      </div>
    </div>
  </div>

  <div style="flex:1; overflow:auto; min-height:0; background:var(--bg,#f0f0f0); padding:1rem;">
    <iframe id="report-frame" src="about:blank" style="border:none; width:100%; height:calc(100% - 2rem); display:block; background:#fff; min-height:37.5rem;"></iframe>
  </div>
</div>
${layoutEnd()}
<script>
(function() {
  var company = ${JSON.stringify(company)};

  /* ── State ── */
  var RPT_META = ${JSON.stringify(rptMeta)};
  var currentType = '';
  /* Handle ?t= URL param (drill-through, e.g. from dashboard or payables/aging) */
  var urlParams = new URLSearchParams(window.location.search);
  var drillThrough = !!urlParams.get('t');
  if (drillThrough) { currentType = urlParams.get('t'); localStorage.setItem('fb-rpt-type', currentType); }
  var drillAccount = urlParams.get('account') || '';

  var currentStep = localStorage.getItem('fb-rpt-step') || '';

  /* ── Type dropdown ── */
  var typeEl = document.getElementById('rpt-type');
  /* Reflect drill-through selection in the dropdown */
  if (currentType && typeEl) { typeEl.value = currentType; }

  /* ── MoM/YoY buttons: enable only for multiperiod reports (registry) ── */
  function updateStepButtons() {
    var momBtn = document.getElementById('rpt-mom');
    var yoyBtn = document.getElementById('rpt-yoy');
    var supported = !!(RPT_META[currentType] && RPT_META[currentType].multiperiod);
    if (!supported) { currentStep = ''; localStorage.setItem('fb-rpt-step', ''); }
    [momBtn, yoyBtn].forEach(function(btn) {
      if (!btn) return;
      btn.disabled = !supported;
      btn.style.opacity = supported ? '' : '0.35';
      btn.style.cursor  = supported ? '' : 'not-allowed';
      btn.classList.toggle('tb-active', btn.id === 'rpt-mom'
        ? currentStep === 'mom' : currentStep === 'yoy');
    });
  }
  updateStepButtons();

  /* ── Per-report relevance override (§4.2) ── */
  /* REPORT_REGISTRY[currentType].needsStart → 'range' | 'asOf'. Called every
     time currentType changes (dropdown, drill-through). */
  function applyReportRelevance() {
    if (!currentType || !RPT_META[currentType]) return;
    FB.period.setRelevance(RPT_META[currentType].needsStart ? 'range' : 'asOf');
  }
  if (currentType) applyReportRelevance();

  /* ── Wire FB.period — report reloads when the global period changes ── */
  FB.period.onChange(function () { fbLoadReport(); });

  /* ── Helpers ── */
  /* buildReportUrl reads from FB.period.get() — the local #rpt-period /
     #rpt-start / #rpt-end DOM elements no longer exist (retired per spec §5). */
  function buildReportUrl() {
    var st = FB.period.get();
    var start = st.start, end = st.end;
    if (!currentType || !end) return null;
    /* As-of reports (registry needsStart:false, e.g. AP Aging) need end only */
    if (RPT_META[currentType] && !RPT_META[currentType].needsStart) {
      return '/api/' + company + '/report?type=' + encodeURIComponent(currentType) + '&end=' + encodeURIComponent(end);
    }
    if (!start) return null;
    var url = '/api/' + company + '/report?type=' + encodeURIComponent(currentType)
            + '&start=' + encodeURIComponent(start)
            + '&end='   + encodeURIComponent(end);
    if (drillAccount) url += '&account=' + encodeURIComponent(drillAccount);
    if (currentStep && RPT_META[currentType] && RPT_META[currentType].multiperiod) url += '&step=' + currentStep;
    return url;
  }

  /* ── Download dropdown menu ── */
  var _dlOpen = false;
  
  function closeDownloadMenu() {
    var dd = document.getElementById('rpt-dl-dd');
    if (dd) dd.style.display = 'none';
    _dlOpen = false;
    // Remove iframe listener
    try {
      var frame = document.getElementById('report-frame');
      if (frame && frame.contentDocument) {
        frame.contentDocument.removeEventListener('click', closeDownloadMenu);
      }
    } catch(e) {}
  }
  
  window.fbToggleDownload = function(e) {
    e.stopPropagation();
    var dd = document.getElementById('rpt-dl-dd');
    if (!dd) return;
    if (_dlOpen) { closeDownloadMenu(); return; }
    dd.style.display = '';
    _dlOpen = true;
    // Catch clicks inside iframe to close menu
    try {
      var frame = document.getElementById('report-frame');
      if (frame && frame.contentDocument) {
        frame.contentDocument.addEventListener('click', closeDownloadMenu);
      }
    } catch(e) {}
  };
  document.addEventListener('click', function(e) {
    if (!_dlOpen) return;
    var btn = document.getElementById('rpt-dl-btn');
    var dd = document.getElementById('rpt-dl-dd');
    if (btn && btn.contains(e.target)) return;
    if (dd && dd.contains(e.target)) return;
    closeDownloadMenu();
  });

  /* ── Public handlers ── */
  window.fbOnTypeChange = function() {
    var val = typeEl ? typeEl.value : '';
    if (!val) return;
    if (val) currentType = val;
    localStorage.setItem('fb-rpt-type', currentType);
    updateStepButtons();
    applyReportRelevance();
    fbLoadReport();
  };

  window.fbToggleComparison = function(mode) {
    if (!(RPT_META[currentType] && RPT_META[currentType].multiperiod)) return;
    currentStep = (currentStep === mode) ? '' : mode;
    localStorage.setItem('fb-rpt-step', currentStep);
    updateStepButtons();
    fbLoadReport();
  };

  /* K3e: debounced report loader. Wrapping fbLoadReport with a pending flag +
   * setTimeout(0) coalescer means a change-event (mouse/select onchange) and
   * the onCommit hook (INSERT Enter commit) — which fire within the same
   * tick — collapse into exactly one report load. The actual work is in
   * _doLoadReport; fbLoadReport is the debounced public entry point.
   */
  var _rptLoadPending = false;
  var _doLoadReport = function() {
    var st = FB.period.get();
    var end = st.end;
    localStorage.setItem('fb-rpt-type', currentType);
    if (!end) return;
    var frame = document.getElementById('report-frame');
    if (!frame) return;
    var url = buildReportUrl();
    if (url) frame.src = url;
    frame.addEventListener('load', function onFrameLoad() {
      try {
        var doc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
        if (!doc || !doc.head) return;
        var existing = doc.getElementById('fb-theme-inject');
        if (existing) existing.remove();
        var theme = document.documentElement.getAttribute('data-theme') || 'light';
        var bgColor = theme === 'dark' ? '#0e1520' : '#f2f4f7';
        var fgColor = theme === 'dark' ? '#e0e0e0' : 'inherit';
        var s = doc.createElement('style');
        s.id = 'fb-theme-inject';
        s.textContent = 'html,body{background:' + bgColor + '!important;color:' + fgColor + '!important}' +
          '@media print{html,body{background:#fff!important;color:#000!important}}';
        doc.head.appendChild(s);
        // K3d: forward non-editable keydowns from the iframe to the parent
        // document so FB.keys bindings survive focus inside the frame.
        if (window.FB && FB.util && FB.util.forwardIframeKeys) FB.util.forwardIframeKeys(frame);
      } catch(e) {}
    });
  };
  window.fbLoadReport = function() {
    if (_rptLoadPending) return;
    _rptLoadPending = true;
    setTimeout(function () { _rptLoadPending = false; _doLoadReport(); }, 0);
  };

  /* ── PDF / CSV export ── */
  window.fbExportPDF = function() {
    closeDownloadMenu();
    var url = buildReportUrl();
    if (!url) { alert('Select a report and date range first.'); return; }
    window.open(url, '_blank');
  };

  window.fbExportCSV = function() {
    closeDownloadMenu();
    var frame = document.getElementById('report-frame');
    var st = FB.period.get();
    var start = st.start, end = st.end;
    if (!frame || frame.src === 'about:blank') { alert('Load a report first.'); return; }
    try {
      var doc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
      if (!doc) { alert('Report still loading — try again in a moment.'); return; }
      var tables = doc.querySelectorAll('table');
      if (!tables.length) { alert('No tabular data in this report.'); return; }
      var rows = [];
      tables.forEach(function(tbl) {
        tbl.querySelectorAll('tr').forEach(function(tr) {
          var cells = Array.from(tr.querySelectorAll('th,td'));
          if (cells.length) rows.push(cells.map(function(c) {
            return '"' + c.textContent.trim().replace(/"/g, '""') + '"';
          }).join(','));
        });
        rows.push('');
      });
      var blob = new Blob([rows.join('\\n')], { type: 'text/csv;charset=utf-8;' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = currentType + (start ? '_' + start : '') + (end ? '_' + end : '') + '.csv';
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
    } catch(ex) { alert('CSV export failed: ' + ex.message); }
  };

  /* SIE 4 ledger export — server-side file (PC8), independent of report type;
     only the date range matters. Content-Disposition:attachment makes the
     browser save it directly from the URL. */
  window.fbExportSIE = function() {
    closeDownloadMenu();
    var st = FB.period.get();
    var start = st.start, end = st.end;
    if (!start || !end) { alert('Select a date range first.'); return; }
    var a = document.createElement('a');
    a.href = '/api/' + company + '/report?type=sie&start=' + encodeURIComponent(start) + '&end=' + encodeURIComponent(end);
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
  };

  /* ── FB.form (K3b, keyboard-ux-spec §8) — the filter bar is a header-only
     form: j/k rows, h/l cells, i/Enter edit, Esc exit. MoM/YoY are h/l-
     navigable toggle-button cells; ~ flips the FOCUSED comparison button
     only (re-toggle returns to none — fbToggleComparison's own semantics),
     never a group cycle (magnus 2026-07-28). d opens the download menu
     with a j/k/Enter/Esc mini-scope (context override: no delete here). ── */

  var dlIdx = -1;
  function dlRows() {
    var dd = document.getElementById('rpt-dl-dd');
    return dd ? Array.from(dd.querySelectorAll('button')) : [];
  }
  function paintDl() {
    // Keyboard highlight = the vim cell-cursor convention (--accent navy fill +
    // white text, same as .nav-row-focus) — var(--bg) was unreadably weak (magnus).
    dlRows().forEach(function (b, i) {
      var on = (i === dlIdx);
      b.style.background = on ? 'var(--accent)' : '';
      b.style.color = on ? '#fff' : '';
    });
  }

  var rptForm = FB.form.create({
    formId: 'reports',
    onCommit: function () { fbLoadReport(); },
    zones: [
      // The filter bar is a single header row whose cells are the bar's
      // controls in visual order. The default cells() hook only finds
      // input/select/textarea — buttons (MoM/YoY/download) would be skipped,
      // so declare them explicitly. Button cells activate on Enter/i (click)
      // via fb-form's generic button handling (keyboard-ux-spec §8).
      { id: 'filters', rows: function () { return [document.querySelector('.tb-controls-row')]; },
        cells: function (row) {
          return [
            document.getElementById('rpt-type'),
            document.getElementById('rpt-mom'),
            document.getElementById('rpt-yoy'),
            document.getElementById('rpt-dl-btn')
          ].filter(Boolean);
        } }
    ],
    extraBindings: function (api) {
      return [
        { key: '~', mode: 'NORMAL', hint: 'comparison', hintBar: true, run: function () {
            var el = api.cellEl();
            if (el && (el.id === 'rpt-mom' || el.id === 'rpt-yoy')) el.click();
          } },
        { key: 'd', mode: 'NORMAL', hint: 'download', hintBar: true,
          when: function () { return !_dlOpen; },
          run: function () { document.getElementById('rpt-dl-btn').click(); dlIdx = 0; paintDl(); } },
        { key: 'j', mode: 'NORMAL', when: function () { return _dlOpen; }, run: function () { dlIdx = Math.min(dlIdx + 1, dlRows().length - 1); paintDl(); } },
        { key: 'k', mode: 'NORMAL', when: function () { return _dlOpen; }, run: function () { dlIdx = Math.max(dlIdx - 1, 0); paintDl(); } },
        { key: 'ArrowDown', mode: 'NORMAL', when: function () { return _dlOpen; }, run: function () { dlIdx = Math.min(dlIdx + 1, dlRows().length - 1); paintDl(); } },
        { key: 'ArrowUp', mode: 'NORMAL', when: function () { return _dlOpen; }, run: function () { dlIdx = Math.max(dlIdx - 1, 0); paintDl(); } },
        { key: 'Enter', mode: 'NORMAL', when: function () { return _dlOpen; }, run: function () { var r = dlRows()[dlIdx]; if (r) r.click(); } },
        { key: 'Escape', mode: 'NORMAL', when: function () { return _dlOpen; }, run: function () { closeDownloadMenu(); } }
      ];
    }
  });
  FB.keys.renderHints('reports', document.getElementById('sb-hints'), { layout: 'list' });

// ArrowDown on either select opens the FULL option list (FB.dropdown
// overlay; magnus 2026-07-28 — "drop down the full list, not just switch
// the cell value"). The source reads live options, so the periods fetch
// needs no coordination. Pick fires change → the handlers above reload.
FB.dropdown.attachSelect(document.getElementById('rpt-type'));

})();
</script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

/**
 * Resolve whether the SIE export affordance should render for this company.
 * SIE is a Swedish statutory audit format — the export only renders when the
 * company's jurisdiction pack declares integrations.sie.export (the
 * /report?type=sie endpoint enforces the same gate server-side).
 */
async function isSieExportEnabled(company) {
  try {
    const jurRows = await queryPositional(
      `SELECT jurisdiction FROM companies WHERE company_id = ? ORDER BY created_at DESC LIMIT 1`, [company]);
    const integ = jurRows.length ? packIntegration(jurRows[0].jurisdiction, 'sie') : null;
    return !!(integ && integ.export);
  } catch { return false; }
}

/** Statements hub — financial statement output (PL, BS, CF, SCE). */
async function handleStatementsHubPage(req, res) {
  return buildHubPage(req, res, { pageKey: 'statements', pageTitle: 'Statements', activeKey: 'statements' });
}

/** Books hub — ledger / audit tooling (voucher register, TB, GL, journal, integrity). */
async function handleBooksHubPage(req, res) {
  return buildHubPage(req, res, { pageKey: 'books', pageTitle: 'Books', activeKey: 'books' });
}

module.exports = { handleStatementsHubPage, handleBooksHubPage };
