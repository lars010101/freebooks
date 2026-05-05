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

  /* \u2500\u2500 State \u2500\u2500 */
  var currentType = localStorage.getItem('fb-rpt-type')   || 'pl';
  var currentStep = localStorage.getItem('fb-rpt-step')   || '';
  var savedPeriod = localStorage.getItem('fb-rpt-period') || '';
  var savedStart  = localStorage.getItem('fb-rpt-start')  || '';
  var savedEnd    = localStorage.getItem('fb-rpt-end')    || '';

  /* \u2500\u2500 Restore type dropdown \u2500\u2500 */
  var typeEl = document.getElementById('rpt-type');
  if (typeEl) {
    for (var i = 0; i < typeEl.options.length; i++) {
      if (typeEl.options[i].value === currentType) { typeEl.selectedIndex = i; break; }
    }
  }

  /* \u2500\u2500 Restore MoM/YoY buttons \u2500\u2500 */
  function restoreStepButtons() {
    var momBtn = document.getElementById('rpt-mom');
    var yoyBtn = document.getElementById('rpt-yoy');
    if (momBtn) momBtn.classList.toggle('tb-active', currentStep === 'mom');
    if (yoyBtn) yoyBtn.classList.toggle('tb-active', currentStep === 'yoy');
  }
  restoreStepButtons();

  /* \u2500\u2500 Load periods \u2500\u2500 */
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

  /* \u2500\u2500 Helpers \u2500\u2500 */
  function fmtDate(d) {
    if (!d) return '';
    if (typeof d === 'string' && /^\\d{4}-\\d{2}-\\d{2}$/.test(d)) return d;
    var dt = new Date(d);
    return isNaN(dt) ? String(d).slice(0, 10) : dt.toISOString().slice(0, 10);
  }

  function buildReportUrl() {
    var start = (document.getElementById('rpt-start') || {}).value || '';
    var end   = (document.getElementById('rpt-end')   || {}).value || '';
    if (!currentType || !start || !end) return null;
    if (currentType === 'ap-aging') return null; /* handled separately */
    var url = '/api/' + company + '/report?type=' + encodeURIComponent(currentType)
            + '&start=' + encodeURIComponent(start)
            + '&end='   + encodeURIComponent(end);
    if (currentStep) url += '&step=' + currentStep;
    return url;
  }

  /* \u2500\u2500 Public handlers \u2500\u2500 */
  window.fbOnTypeChange = function() {
    var val = typeEl ? typeEl.value : '';
    if (val) currentType = val;
    localStorage.setItem('fb-rpt-type', currentType);
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
    currentStep = (currentStep === mode) ? '' : mode;
    restoreStepButtons();
    localStorage.setItem('fb-rpt-step', currentStep);
    fbLoadReport();
  };

  window.fbLoadReport = function() {
    var start  = (document.getElementById('rpt-start')  || {}).value || '';
    var end    = (document.getElementById('rpt-end')    || {}).value || '';
    var period = (document.getElementById('rpt-period') || {}).value || 'custom';
    localStorage.setItem('fb-rpt-type',   currentType);
    localStorage.setItem('fb-rpt-period', period);
    localStorage.setItem('fb-rpt-start',  start);
    localStorage.setItem('fb-rpt-end',    end);

    if (!start || !end) return;
    var frame = document.getElementById('report-frame');
    if (!frame) return;

    /* AP Aging is a full page \u2014 open in new tab */
    if (currentType === 'ap-aging') {
      window.open('/' + company + '/payables/aging', '_blank');
      /* revert to previous valid type */
      currentType = localStorage.getItem('fb-rpt-type-prev') || 'pl';
      if (typeEl) {
        for (var i = 0; i < typeEl.options.length; i++) {
          if (typeEl.options[i].value === currentType) { typeEl.selectedIndex = i; break; }
        }
      }
      return;
    }
    localStorage.setItem('fb-rpt-type-prev', currentType);

    var url = buildReportUrl();
    if (url) frame.src = url;
  };

  /* \u2500\u2500 Download dropdown \u2500\u2500 */
  window.fbToggleDownload = function(e) {
    e.stopPropagation();
    var dd = document.getElementById('rpt-dl-dd');
    if (dd) dd.style.display = dd.style.display === 'none' ? '' : 'none';
  };
  document.addEventListener('click', function() {
    var dd = document.getElementById('rpt-dl-dd');
    if (dd) dd.style.display = 'none';
  });

  window.fbExportPDF = function() {
    var dd = document.getElementById('rpt-dl-dd');
    if (dd) dd.style.display = 'none';
    var url = buildReportUrl();
    if (!url) { alert('Select a report and date range first.'); return; }
    window.open(url, '_blank');
  };

  window.fbExportCSV = function() {
    var dd = document.getElementById('rpt-dl-dd');
    if (dd) dd.style.display = 'none';
    var frame = document.getElementById('report-frame');
    var start = (document.getElementById('rpt-start') || {}).value || '';
    var end   = (document.getElementById('rpt-end')   || {}).value || '';
    if (!frame || frame.src === 'about:blank') { alert('Load a report first.'); return; }
    try {
      var doc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
      if (!doc) { alert('Report still loading \u2014 try again in a moment.'); return; }
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
      var filename = currentType + (start ? '_' + start : '') + (end ? '_' + end : '') + '.csv';
      var blob = new Blob([rows.join('\\n')], { type: 'text/csv;charset=utf-8;' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
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
