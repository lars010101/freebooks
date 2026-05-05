'use strict';
const { navBar, layoutEnd, commonStyle } = require('./common');

async function handleReportsHubPage(req, res) {
  const company = req.params.company;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reports \u2014 freeBooks</title>
${commonStyle()}
<style>
  #page-main { padding: 0 !important; overflow: hidden !important; display: flex; flex-direction: column; }
  #report-frame { flex: 1; border: none; width: 100%; min-height: 0; display: block; }
</style>
</head>
<body>${navBar(company, 'reports')}
<iframe id="report-frame" src="about:blank"></iframe>
${layoutEnd()}
<script>
(function() {
  var company = ${JSON.stringify(company)};

  /* ── State ── */
  var MOM_YOY_TYPES = ['pl', 'bs', 'cf'];
  var currentType = localStorage.getItem('fb-rpt-type') || 'pl';
  /* Handle ?t= URL param (e.g. redirect from payables/aging) */
  var urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('t')) { currentType = urlParams.get('t'); localStorage.setItem('fb-rpt-type', currentType); }

  var currentStep = localStorage.getItem('fb-rpt-step') || '';
  var savedPeriod = localStorage.getItem('fb-rpt-period') || '';
  var savedStart  = localStorage.getItem('fb-rpt-start')  || '';
  var savedEnd    = localStorage.getItem('fb-rpt-end')    || '';

  /* ── Restore type dropdown ── */
  var typeEl = document.getElementById('rpt-type');
  if (typeEl) {
    for (var i = 0; i < typeEl.options.length; i++) {
      if (typeEl.options[i].value === currentType) { typeEl.selectedIndex = i; break; }
    }
  }

  /* ── MoM/YoY buttons: enable only for pl/bs/cf ── */
  function updateStepButtons() {
    var momBtn = document.getElementById('rpt-mom');
    var yoyBtn = document.getElementById('rpt-yoy');
    var supported = MOM_YOY_TYPES.indexOf(currentType) !== -1;
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
      fbLoadReport();
    })
    .catch(function() {
      if (savedStart && savedEnd) {
        document.getElementById('rpt-start').value = savedStart;
        document.getElementById('rpt-end').value   = savedEnd;
      }
      fbLoadReport();
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
    if (currentType === 'ap-aging') {
      return '/api/' + company + '/report?type=ap-aging&end=' + encodeURIComponent(end);
    }
    if (!start) return null;
    var url = '/api/' + company + '/report?type=' + encodeURIComponent(currentType)
            + '&start=' + encodeURIComponent(start)
            + '&end='   + encodeURIComponent(end);
    if (currentStep && MOM_YOY_TYPES.indexOf(currentType) !== -1) url += '&step=' + currentStep;
    return url;
  }

  /* ── Download dropdown overlay ── */
  var _overlayEl = null;
  function closeDownloadMenu() {
    var dd = document.getElementById('rpt-dl-dd');
    if (dd) dd.style.display = 'none';
    if (_overlayEl && _overlayEl.parentNode) _overlayEl.parentNode.removeChild(_overlayEl);
    _overlayEl = null;
  }

  window.fbToggleDownload = function(e) {
    e.stopPropagation();
    var dd = document.getElementById('rpt-dl-dd');
    if (!dd) return;
    var isOpen = dd.style.display !== 'none';
    if (isOpen) { closeDownloadMenu(); return; }
    dd.style.display = '';
    /* overlay to catch clicks inside iframe and anywhere on the page */
    _overlayEl = document.createElement('div');
    _overlayEl.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:200;';
    _overlayEl.addEventListener('click', closeDownloadMenu);
    document.body.appendChild(_overlayEl);
    /* put the download button+menu above the overlay */
    var btn = document.getElementById('rpt-dl-btn');
    if (btn) btn.style.position = 'relative';
    if (dd) dd.style.zIndex = '400';
  };
  document.addEventListener('click', closeDownloadMenu);

  /* ── Public handlers ── */
  window.fbOnTypeChange = function() {
    var val = typeEl ? typeEl.value : '';
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
    if (MOM_YOY_TYPES.indexOf(currentType) === -1) return;
    currentStep = (currentStep === mode) ? '' : mode;
    localStorage.setItem('fb-rpt-step', currentStep);
    updateStepButtons();
    fbLoadReport();
  };

  window.fbLoadReport = function() {
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
      var blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = currentType + (start ? '_' + start : '') + (end ? '_' + end : '') + '.csv';
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
    } catch(ex) { alert('CSV export failed: ' + ex.message); }
  };

})();
</script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

module.exports = { handleReportsHubPage };
