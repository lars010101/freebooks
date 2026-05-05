'use strict';
const { navBar, layoutEnd, commonStyle } = require('./common');

async function handleReportsHubPage(req, res) {
  const company = req.params.company;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reports — freeBooks</title>
${commonStyle()}
<style>
  /* Make page-main a flex container so iframe fills remaining height */
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

  /* ── Restore preferences ── */
  var savedType   = localStorage.getItem('fb-rpt-type')   || 'pl';
  var savedPeriod = localStorage.getItem('fb-rpt-period') || '';
  var savedStart  = localStorage.getItem('fb-rpt-start')  || '';
  var savedEnd    = localStorage.getItem('fb-rpt-end')    || '';

  /* ── Set report type ── */
  var typeEl = document.getElementById('rpt-type');
  if (typeEl) {
    for (var i = 0; i < typeEl.options.length; i++) {
      if (typeEl.options[i].value === savedType) { typeEl.selectedIndex = i; break; }
    }
  }

  /* ── Load periods ── */
  fetch('/api/' + company + '/periods')
    .then(function(r) { return r.json(); })
    .then(function(raw) {
      var periods = (Array.isArray(raw) ? raw : (raw.data || [])).slice().sort(function(a, b) {
        return String(b.start_date) > String(a.start_date) ? 1 : -1;
      });
      var periodEl = document.getElementById('rpt-period');
      if (!periodEl) return;

      var opts = '<option value="custom">Custom dates</option>';
      opts += periods.map(function(p) {
        var s = fmtDate(p.start_date);
        var e = fmtDate(p.end_date);
        var val = s + '|' + e;
        return '<option value="' + val + '">' + (p.period_name || val) + '</option>';
      }).join('');
      periodEl.innerHTML = opts;

      /* Restore or default to most recent period */
      var matched = false;
      if (savedPeriod && savedPeriod !== 'custom') {
        for (var j = 0; j < periodEl.options.length; j++) {
          if (periodEl.options[j].value === savedPeriod) {
            periodEl.selectedIndex = j;
            var parts = savedPeriod.split('|');
            document.getElementById('rpt-start').value = parts[0];
            document.getElementById('rpt-end').value   = parts[1];
            matched = true;
            break;
          }
        }
      }
      if (!matched && savedStart && savedEnd) {
        document.getElementById('rpt-start').value = savedStart;
        document.getElementById('rpt-end').value   = savedEnd;
        periodEl.value = 'custom';
        matched = true;
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
    if (isNaN(dt)) return String(d).slice(0, 10);
    return dt.toISOString().slice(0, 10);
  }

  /* ── Public handlers (called from inline onchange/onclick in top bar) ── */
  window.fbOnPeriodChange = function() {
    var val = document.getElementById('rpt-period').value;
    if (val && val !== 'custom') {
      var parts = val.split('|');
      document.getElementById('rpt-start').value = parts[0];
      document.getElementById('rpt-end').value   = parts[1];
    }
    fbLoadReport();
  };

  window.fbToggleComparison = function(mode) {
    var momBtn = document.getElementById('rpt-mom');
    var yoyBtn = document.getElementById('rpt-yoy');
    if (mode === 'mom') {
      momBtn.classList.toggle('tb-active');
      if (momBtn.classList.contains('tb-active')) yoyBtn.classList.remove('tb-active');
    } else {
      yoyBtn.classList.toggle('tb-active');
      if (yoyBtn.classList.contains('tb-active')) momBtn.classList.remove('tb-active');
    }
    fbLoadReport();
  };

  window.fbToggleFilter = function() {
    var btn = document.getElementById('rpt-filter');
    var inp = document.getElementById('rpt-account');
    btn.classList.toggle('tb-active');
    if (inp) {
      inp.style.display = btn.classList.contains('tb-active') ? '' : 'none';
      if (!btn.classList.contains('tb-active')) inp.value = '';
    }
    fbLoadReport();
  };

  window.fbLoadReport = function() {
    var type  = (document.getElementById('rpt-type')  || {}).value || 'pl';
    var start = (document.getElementById('rpt-start') || {}).value || '';
    var end   = (document.getElementById('rpt-end')   || {}).value || '';
    var period = (document.getElementById('rpt-period') || {}).value || 'custom';

    /* Persist */
    localStorage.setItem('fb-rpt-type',   type);
    localStorage.setItem('fb-rpt-period', period);
    localStorage.setItem('fb-rpt-start',  start);
    localStorage.setItem('fb-rpt-end',    end);

    if (!start || !end) return;

    var frame = document.getElementById('report-frame');
    if (!frame) return;

    /* AP Aging is a separate full page */
    if (type === 'ap-aging') {
      frame.src = '/' + company + '/payables/aging';
      return;
    }

    var url = '/api/' + company + '/report?type=' + encodeURIComponent(type)
            + '&start=' + encodeURIComponent(start)
            + '&end='   + encodeURIComponent(end);

    var mom = document.getElementById('rpt-mom').classList.contains('tb-active');
    var yoy = document.getElementById('rpt-yoy').classList.contains('tb-active');
    if (mom)      url += '&step=mom';
    else if (yoy) url += '&step=yoy';

    var filterActive = document.getElementById('rpt-filter').classList.contains('tb-active');
    if (filterActive) {
      var acct = (document.getElementById('rpt-account') || {}).value || '';
      if (acct.trim()) url += '&account=' + encodeURIComponent(acct.trim());
    }

    frame.src = url;
  };

  /* ── Helper: build current report URL ── */
  function buildReportUrl() {
    var type  = (document.getElementById('rpt-type')  || {}).value || '';
    var start = (document.getElementById('rpt-start') || {}).value || '';
    var end   = (document.getElementById('rpt-end')   || {}).value || '';
    if (!type || !start || !end) return null;
    if (type === 'ap-aging') return '/' + company + '/payables/aging';
    var url = '/api/' + company + '/report?type=' + encodeURIComponent(type)
            + '&start=' + encodeURIComponent(start)
            + '&end='   + encodeURIComponent(end);
    var mom = document.getElementById('rpt-mom').classList.contains('tb-active');
    var yoy = document.getElementById('rpt-yoy').classList.contains('tb-active');
    if (mom)      url += '&step=mom';
    else if (yoy) url += '&step=yoy';
    var filterActive = document.getElementById('rpt-filter').classList.contains('tb-active');
    if (filterActive) {
      var acct = (document.getElementById('rpt-account') || {}).value || '';
      if (acct.trim()) url += '&account=' + encodeURIComponent(acct.trim());
    }
    return url;
  }

  /* ── PDF: open report standalone in new tab (no sidebar/nav) ── */
  window.fbExportPDF = function() {
    var url = buildReportUrl();
    if (!url) { alert('Select a report and date range first.'); return; }
    window.open(url, '_blank');
  };

  /* ── CSV: client-side extraction from loaded iframe ── */
  window.fbExportCSV = function() {
    var frame = document.getElementById('report-frame');
    var type  = (document.getElementById('rpt-type')  || {}).value || 'report';
    var start = (document.getElementById('rpt-start') || {}).value || '';
    var end   = (document.getElementById('rpt-end')   || {}).value || '';
    if (!frame || !frame.src || frame.src === 'about:blank') {
      alert('Load a report first.'); return;
    }
    try {
      var doc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
      if (!doc) { alert('Report not accessible yet — wait for it to finish loading.'); return; }
      var tables = doc.querySelectorAll('table');
      if (!tables.length) { alert('No tabular data found in this report.'); return; }
      var csvRows = [];
      tables.forEach(function(table) {
        table.querySelectorAll('tr').forEach(function(row) {
          var cells = Array.from(row.querySelectorAll('th, td'));
          if (!cells.length) return;
          csvRows.push(cells.map(function(c) {
            return '"' + c.textContent.trim().replace(/"/g, '""') + '"';
          }).join(','));
        });
        csvRows.push('');
      });
      var filename = type + (start ? '_' + start : '') + (end ? '_' + end : '') + '.csv';
      var blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
      var link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);
    } catch(e) {
      alert('CSV export failed: ' + e.message);
    }
  };

})();
</script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

module.exports = { handleReportsHubPage };
