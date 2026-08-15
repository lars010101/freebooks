'use strict';
const { navBar, layoutEnd, commonStyle } = require('./common');
const { REPORT_REGISTRY, reportsByCategory } = require('../report-registry');
const { queryPositional } = require('../db');
const { packIntegration } = require('../jurisdiction-packs');

async function handleReportsHubPage(req, res) {
  const company = req.params.company;

  // SIE is a Swedish statutory format — the export affordance only renders
  // when the company's jurisdiction pack declares integrations.sie.export
  // (the /report?type=sie endpoint enforces the same gate server-side).
  let sieExportEnabled = false;
  try {
    const jurRows = await queryPositional(
      `SELECT jurisdiction FROM companies WHERE company_id = ? ORDER BY created_at DESC LIMIT 1`, [company]);
    const integ = jurRows.length ? packIntegration(jurRows[0].jurisdiction, 'sie') : null;
    sieExportEnabled = !!(integ && integ.export);
  } catch { sieExportEnabled = false; }

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
        ${sieExportEnabled ? '<button onclick="fbExportSIE()" title="SIE 4 ledger export (Gredor/Bolagsverket)" style="display:block;width:100%;padding:9px 16px;background:none;border:none;text-align:left;cursor:pointer;font-size:0.875rem;color:var(--text)">⬇ SIE</button>' : ''}
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
  var startParam = urlParams.get('start') || '';
  var endParam = urlParams.get('end') || '';

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
      var periodParam = urlParams.get('period') || '';
      var periodLoaded = false;
      // v7: Priority for period selection:
      //   1. ?period= URL param (explicit navigation intent from :report)
      //   2. Latest posted-transaction period (fetched from backend)
      //   3. Fallback: periods[0] (latest by start_date)
      // localStorage is NOT used for auto-selection — it was causing stale 2025 periods.
      // localStorage is only written when the user manually picks a period.
      if (periodParam && periods.length) {
        var tok = periodParam.trim().toLowerCase();
        var matchedPeriod = null;
        var setAndLoad = function (p) {
          var s = fmtDate(p.start_date), e = fmtDate(p.end_date);
          for (var k = 0; k < periodEl.options.length; k++) {
            if (periodEl.options[k].value === s + '|' + e) { periodEl.selectedIndex = k; break; }
          }
          document.getElementById('rpt-start').value = s;
          document.getElementById('rpt-end').value = e;
          localStorage.setItem('fb-rpt-period', s + '|' + e);
          localStorage.setItem('fb-rpt-start', s);
          localStorage.setItem('fb-rpt-end', e);
          fbLoadReport();
        };
        // 1. exact period_name match (case-insensitive)
        for (var pi = 0; pi < periods.length; pi++) {
          if ((periods[pi].period_name || '').toLowerCase() === tok) { matchedPeriod = periods[pi]; break; }
        }
        // 2. quarter shorthand q1-q4
        if (!matchedPeriod && /^q[1-4]$/.test(tok)) {
          for (var pi2 = 0; pi2 < periods.length; pi2++) {
            var pn = (periods[pi2].period_name || '').toLowerCase();
            if (pn.indexOf(tok) !== -1) { matchedPeriod = periods[pi2]; break; }
          }
          if (!matchedPeriod) {
            var qn = parseInt(tok.slice(1), 10);
            var qStart = [0, 3, 6, 9][qn - 1];
            var qEnd = qStart + 2;
            var year = periods.length ? String(periods[0].start_date).slice(0, 4) : String(new Date().getFullYear());
            for (var pi3 = 0; pi3 < periods.length; pi3++) {
              var ps = String(periods[pi3].start_date).slice(0, 10);
              var pe = String(periods[pi3].end_date).slice(0, 10);
              var psm = parseInt(ps.slice(5, 7), 10);
              var pem = parseInt(pe.slice(5, 7), 10);
              if (ps.slice(0, 4) === year && psm >= qStart + 1 && pem <= qEnd + 1) { matchedPeriod = periods[pi3]; break; }
            }
          }
        }
        // 3. half-year shorthand h1/h2
        if (!matchedPeriod && /^h[12]$/.test(tok)) {
          var half = parseInt(tok.slice(1), 10);
          var yearH = periods.length ? String(periods[0].start_date).slice(0, 4) : String(new Date().getFullYear());
          for (var pi4 = 0; pi4 < periods.length; pi4++) {
            var hs = String(periods[pi4].start_date).slice(0, 10);
            var he = String(periods[pi4].end_date).slice(0, 10);
            var hsm = parseInt(hs.slice(5, 7), 10);
            var hem = parseInt(he.slice(5, 7), 10);
            if (hs.slice(0, 4) === yearH && half === 1 && hsm >= 1 && hem <= 6) { matchedPeriod = periods[pi4]; break; }
            if (hs.slice(0, 4) === yearH && half === 2 && hsm >= 7 && hem <= 12) { matchedPeriod = periods[pi4]; break; }
          }
        }
        // 4. ytd — full range of all periods
        if (!matchedPeriod && tok === 'ytd') {
          var earliest = periods[0], latest = periods[0];
          for (var pi5 = 0; pi5 < periods.length; pi5++) {
            if (String(periods[pi5].start_date) < String(earliest.start_date)) earliest = periods[pi5];
            if (String(periods[pi5].end_date) > String(latest.end_date)) latest = periods[pi5];
          }
          var sY = fmtDate(earliest.start_date), eY = fmtDate(latest.end_date);
          periodEl.value = 'custom';
          document.getElementById('rpt-start').value = sY;
          document.getElementById('rpt-end').value = eY;
          localStorage.setItem('fb-rpt-period', 'custom');
          localStorage.setItem('fb-rpt-start', sY);
          localStorage.setItem('fb-rpt-end', eY);
          periodLoaded = true;
          fbLoadReport();
        } else if (matchedPeriod) {
          periodLoaded = true;
          setAndLoad(matchedPeriod);
        }
      } else if (startParam && endParam) {
        // Restore period from ?start=&end= (drill-through return navigation).
        // Try to match a known period for the dropdown; fall back to "custom".
        var matched = false;
        for (var si = 0; si < periods.length; si++) {
          var ss = fmtDate(periods[si].start_date), se = fmtDate(periods[si].end_date);
          if (ss === startParam && se === endParam) {
            for (var sj = 0; sj < periodEl.options.length; sj++) {
              if (periodEl.options[sj].value === ss + '|' + se) { periodEl.selectedIndex = sj; break; }
            }
            matched = true;
            break;
          }
        }
        if (!matched) periodEl.value = 'custom';
        document.getElementById('rpt-start').value = startParam;
        document.getElementById('rpt-end').value = endParam;
        localStorage.setItem('fb-rpt-start', startParam);
        localStorage.setItem('fb-rpt-end', endParam);
        periodLoaded = true;
        if (drillThrough) fbLoadReport();
      } else if (periods.length) {
        // v7: No ?period= param — fetch the latest posted-transaction period.
        // This always runs, ignoring stale localStorage.
        fetch('/api/' + company + '/reports/default-period')
          .then(function(r) { return r.json(); })
          .then(function(res) {
            if (res && res.period_id) {
              for (var pi = 0; pi < periods.length; pi++) {
                if (periods[pi].period_id === res.period_id) {
                  var s = fmtDate(periods[pi].start_date), e = fmtDate(periods[pi].end_date);
                  for (var k = 0; k < periodEl.options.length; k++) {
                    if (periodEl.options[k].value === s + '|' + e) { periodEl.selectedIndex = k; break; }
                  }
                  document.getElementById('rpt-start').value = s;
                  document.getElementById('rpt-end').value = e;
                  if (drillThrough) fbLoadReport();
                  return;
                }
              }
            }
            // Fallback: periods[0]
            var p0 = periods[0];
            var s0 = fmtDate(p0.start_date), e0 = fmtDate(p0.end_date);
            document.getElementById('rpt-start').value = s0;
            document.getElementById('rpt-end').value = e0;
            periodEl.value = s0 + '|' + e0;
            if (drillThrough) fbLoadReport();
          })
          .catch(function() {
            var p0 = periods[0];
            var s0 = fmtDate(p0.start_date), e0 = fmtDate(p0.end_date);
            document.getElementById('rpt-start').value = s0;
            document.getElementById('rpt-end').value = e0;
            periodEl.value = s0 + '|' + e0;
            if (drillThrough) fbLoadReport();
          });
      }
      // Note: drillThrough loads happen inside the period resolution above
      // (both in the ?period= path and the default-period fetch path).
      // No synchronous fallback load here — the async fetch handles it.
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

  /* SIE 4 ledger export — server-side file (PC8), independent of report type;
     only the date range matters. Content-Disposition:attachment makes the
     browser save it directly from the URL. */
  window.fbExportSIE = function() {
    closeDownloadMenu();
    var start = (document.getElementById('rpt-start') || {}).value || '';
    var end   = (document.getElementById('rpt-end')   || {}).value || '';
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
FB.dropdown.attachSelect(document.getElementById('rpt-period'));

})();
</script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

module.exports = { handleReportsHubPage };
