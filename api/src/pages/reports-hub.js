'use strict';
const { navBar, layoutEnd, commonStyle } = require('./common');
const { REPORT_REGISTRY, reportsByCategory } = require('../report-registry');

async function handleReportsHubPage(req, res) {
  const company = req.params.company;

  // Dropdown + client behavior driven by the report registry
  // (docs/reports-dashboard-spec.md §4) — add a report there, not here.
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const typeOptgroups = reportsByCategory().map(g =>
    `<optgroup label="${esc(g.label)}">` +
    g.reports.map(r => `<option value="${r.id}">${esc(r.label)}</option>`).join('') +
    `</optgroup>`
  ).join('\n      ');
  const rptMeta = {};
  for (const r of REPORT_REGISTRY) rptMeta[r.id] = { multiperiod: !!r.multiperiod, needsStart: !!r.needsStart };

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reports \u2014 freeBooks</title>
${commonStyle()}
</head>
<body>${navBar(company, 'reports')}
<div class="page" style="display:flex; flex-direction:column; height:100%; padding:0; overflow:hidden; max-width:none;">
  <div class="header" style="flex-shrink:0; padding:2.25rem 3rem 0;">
    <h1>\u{1F4C8} Reports</h1>
  </div>

  <div class="tb-controls-row" style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:0.75rem 3rem; border-bottom:1px solid var(--border,#e8e8e8); flex-shrink:0;">
    <select id="rpt-type" class="tb-select" style="min-width:168px" onchange="fbOnTypeChange()">
      <option value="" disabled selected>Select report…</option>
      ${typeOptgroups}
    </select>
    <div class="tb-divider"></div>
    <select id="rpt-period" class="tb-select" style="min-width:110px" onchange="fbOnPeriodChange()" title="Period"><option value="">—</option></select>
    <input type="date" id="rpt-start" class="tb-date-input" onchange="fbLoadReport()" title="Start date">
    <span style="color:var(--text-muted);padding:0 3px;font-size:0.875rem">–</span>
    <input type="date" id="rpt-end" class="tb-date-input" onchange="fbLoadReport()" title="End date">
    <button class="tb-toggle-btn" id="rpt-mom" onclick="fbToggleComparison('mom')" title="Month-over-month" style="margin-left:8px">MoM</button>
    <button class="tb-toggle-btn" id="rpt-yoy" onclick="fbToggleComparison('yoy')" title="Year-over-year">YoY</button>
    <div style="position:relative;margin-left:auto">
      <button class="tb-icon-btn" id="rpt-dl-btn" onclick="fbToggleDownload(event)" title="Download report">⬇</button>
      <div id="rpt-dl-dd" style="display:none;position:absolute;right:0;top:calc(100% + 4px);background:var(--surface);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.12);z-index:300;min-width:140px;padding:4px 0">
        <button onclick="fbExportPDF()" style="display:block;width:100%;padding:9px 16px;background:none;border:none;text-align:left;cursor:pointer;font-size:0.875rem;color:var(--text)">🖳 Print / PDF</button>
        <button onclick="fbExportCSV()" style="display:block;width:100%;padding:9px 16px;background:none;border:none;text-align:left;cursor:pointer;font-size:0.875rem;color:var(--text)">⬇ CSV</button>
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

  var currentStep = localStorage.getItem('fb-rpt-step') || '';
  var savedPeriod = localStorage.getItem('fb-rpt-period') || '';
  var savedStart  = localStorage.getItem('fb-rpt-start')  || '';
  var savedEnd    = localStorage.getItem('fb-rpt-end')    || '';

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

  /* ── Load periods ── */
  fetch('/api/' + company + '/periods')
    .then(function(r) { return r.json(); })
    .then(function(raw) {
      var periods = (Array.isArray(raw) ? raw : (raw.data || [])).slice().sort(function(a, b) {
        return String(b.start_date) > String(a.start_date) ? 1 : -1;
      });
      var periodEl = document.getElementById('rpt-period');
      if (!periodEl) return;
      var opts = '<option value="custom">Custom</option>';
      opts += periods.map(function(p) {
        var s = fmtDate(p.start_date), e = fmtDate(p.end_date);
        return '<option value="' + s + '|' + e + '">' + (p.period_name || s) + '</option>';
      }).join('');
      periodEl.innerHTML = opts;
      var matched = false;
      if (savedPeriod && savedPeriod !== 'custom') {
        for (var j = 0; j < periodEl.options.length; j++) {
          if (periodEl.options[j].value === savedPeriod) {
            periodEl.selectedIndex = j;
            var pts = savedPeriod.split('|');
            document.getElementById('rpt-start').value = pts[0];
            document.getElementById('rpt-end').value   = pts[1];
            matched = true; break;
          }
        }
      }
      if (!matched && savedStart && savedEnd) {
        document.getElementById('rpt-start').value = savedStart;
        document.getElementById('rpt-end').value   = savedEnd;
        periodEl.value = 'custom'; matched = true;
      }
      if (!matched && periods.length) {
        var p0 = periods[0];
        var s0 = fmtDate(p0.start_date), e0 = fmtDate(p0.end_date);
        document.getElementById('rpt-start').value = s0;
        document.getElementById('rpt-end').value   = e0;
        periodEl.value = s0 + '|' + e0;
      }
      // Drill-through (?t=) is explicit navigation intent — load immediately;
      // plain visits stay manual (user picks params, report fires on interaction)
      if (drillThrough) fbLoadReport();
    })
    .catch(function() {
      if (savedStart && savedEnd) {
        document.getElementById('rpt-start').value = savedStart;
        document.getElementById('rpt-end').value   = savedEnd;
      }
      if (drillThrough) fbLoadReport();
    });

  /* ── Helpers ── */
  function fmtDate(d) {
    if (!d) return '';
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    var dt = new Date(d);
    return isNaN(dt) ? String(d).slice(0, 10) : dt.toISOString().slice(0, 10);
  }

  function buildReportUrl() {
    var start = (document.getElementById('rpt-start') || {}).value || '';
    var end   = (document.getElementById('rpt-end')   || {}).value || '';
    if (!currentType || !end) return null;
    /* As-of reports (registry needsStart:false, e.g. AP Aging) need end only */
    if (RPT_META[currentType] && !RPT_META[currentType].needsStart) {
      return '/api/' + company + '/report?type=' + encodeURIComponent(currentType) + '&end=' + encodeURIComponent(end);
    }
    if (!start) return null;
    var url = '/api/' + company + '/report?type=' + encodeURIComponent(currentType)
            + '&start=' + encodeURIComponent(start)
            + '&end='   + encodeURIComponent(end);
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
    fbLoadReport();
  };

  window.fbOnPeriodChange = function() {
    var val = (document.getElementById('rpt-period') || {}).value || '';
    if (val && val !== 'custom') {
      var pts = val.split('|');
      document.getElementById('rpt-start').value = pts[0];
      document.getElementById('rpt-end').value   = pts[1];
    }
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
    var start  = (document.getElementById('rpt-start')  || {}).value || '';
    var end    = (document.getElementById('rpt-end')    || {}).value || '';
    var period = (document.getElementById('rpt-period') || {}).value || 'custom';
    localStorage.setItem('fb-rpt-type',   currentType);
    localStorage.setItem('fb-rpt-period', period);
    if (start) localStorage.setItem('fb-rpt-start', start);
    if (end)   localStorage.setItem('fb-rpt-end',   end);
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
    var start = (document.getElementById('rpt-start') || {}).value || '';
    var end   = (document.getElementById('rpt-end')   || {}).value || '';
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
    dlRows().forEach(function (b, i) { b.style.background = (i === dlIdx) ? 'var(--bg)' : ''; });
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
            document.getElementById('rpt-period'),
            document.getElementById('rpt-start'),
            document.getElementById('rpt-end'),
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
FB.dropdown.attachSelect(document.getElementById('rpt-period'));

})();
</script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

module.exports = { handleReportsHubPage };
