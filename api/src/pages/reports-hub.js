'use strict';
const { navBar, layoutEnd, commonStyle } = require('./common');
const { REPORT_REGISTRY, reportsByPage } = require('../report-registry');
const { queryPositional } = require('../db');
const { packIntegration } = require('../jurisdiction-packs');

/**
 * Shared page builder for the Statements and Journal hubs.
 *
 * The two hubs are structurally identical — they differ only in which slice of
 * the report registry they expose (page='statements' vs page='journal'), the
 * page title, the navbar active key, whether the SIE export affordance is
 * rendered (Journal only — SIE is a Swedish statutory ledger export), whether
 * MoM/YoY comparison chrome renders at all (Statements only — every Journal
 * report is multiperiod:false), and optional per-tab label overrides (Journal
 * relabels two report ids without touching REPORT_REGISTRY, §3.2).
 *
 * IA restructure 3 (2026-08-30, docs/ia-restructure-3-spec.md §1): the
 * report-type `<select>` + single iframe are replaced by a tab strip + a
 * fetch-and-cache fragment loader. Fetching the full report page and
 * extracting its `.page` element client-side avoids a nested-document
 * navigation (no duplicate `<head>`/CSS parse) with zero server-side change;
 * a per-URL in-memory cache means revisiting a tab already fetched this
 * session renders instantly.
 *
 * @param {object}   req
 * @param {object}   res
 * @param {object}   opts
 * @param {string}   opts.pageKey         'statements' | 'journal' — selects reportsByPage()
 * @param {string}   opts.pageTitle       Human title, e.g. 'Statements'
 * @param {string}   opts.activeKey       navBar active key, e.g. 'statements' | 'journal'
 * @param {boolean}  opts.showComparison  Whether MoM/YoY chrome renders at all on this page
 * @param {object}   [opts.labelOverrides] { reportId: label } — tab text override, id/route untouched
 */
async function buildHubPage(req, res, opts) {
  const { pageKey, pageTitle, activeKey, showComparison, labelOverrides = {} } = opts;
  const company = req.params.company;

  // SIE export lives in the unified topbar download icon now (common.js /
  // fb-core.js, ia-restructure-3-spec.md §6.3), not this page — it's a
  // company+period scoped ledger export, not tied to any one report/tab, and
  // that icon's own /sie-status check gates it on the jurisdiction pack the
  // same way /report?type=sie does server-side. Nothing to compute here.
  // Tab strip + client behavior driven by the report registry
  // (docs/reports-dashboard-spec.md §4) — add a report there, not here.
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const pageReports = reportsByPage(pageKey);
  const tabsHtml = pageReports.map((r, i) =>
    `<div class="tab${i === 0 ? ' active' : ''}" data-type="${r.id}" onclick="fbSelectType('${r.id}')">${esc(labelOverrides[r.id] || r.label)}</div>`
  ).join('\n    ');
  const rptMeta = {};
  for (const r of pageReports) rptMeta[r.id] = { multiperiod: !!r.multiperiod, needsStart: !!r.needsStart };

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(pageTitle)} — freeBooks</title>
${commonStyle()}
<style>
  .tabs { display:flex; gap:0; border-bottom:2px solid var(--text,#1a1a1a); flex-shrink:0; padding:0 3rem; }
  .tab { padding:8px 20px; cursor:pointer; font-weight:600; font-size:0.8125rem; color:var(--text-muted,#555); border-bottom:3px solid transparent; margin-bottom:-2px; }
  .tab.active { color:var(--text,#1a1a1a); border-bottom-color:var(--text,#1a1a1a); }
  /* Report fragment styling — mirrors reports/render.js htmlPage()'s embedded
     <style> block (that CSS never ships to the client here; only the .page
     element's markup does), made theme-aware via the app's CSS vars. */
  .rpt-embed { background:var(--surface,#fff); border-radius:8px; }
  .rpt-embed .page { padding:24px 32px; max-width:none; }
  .rpt-embed .page.wide .table-wrap { overflow-x:auto; }
  .rpt-embed .page.wide th { white-space:nowrap; }
  /* Company/report-title/period repeats page chrome the app already shows —
     hidden on screen (ia-restructure-3-spec.md §6.2). PDF export opens the
     report's own standalone URL raw, not this fragment, so it keeps its
     header regardless (reports/render.js's own per-report stylesheet). */
  .rpt-embed .header { display:none; }
  .rpt-embed .company { font-size:16pt; font-weight:700; color:var(--text); }
  .rpt-embed .report-title { font-size:13pt; color:var(--text-muted,#444); margin-top:4px; }
  .rpt-embed .period { font-size:10pt; color:var(--text-muted,#666); margin-top:2px; }
  .rpt-embed table { width:100%; border-collapse:collapse; margin-top:8px; }
  .rpt-embed th { text-align:left; font-size:9pt; text-transform:uppercase; letter-spacing:0.05em; color:var(--text-muted,#555); border-bottom:1px solid var(--border,#ccc); padding:6px 8px; }
  .rpt-embed th.num { text-align:right; }
  .rpt-embed td { padding:5px 8px; border-bottom:1px solid var(--border,#f0f0f0); vertical-align:top; color:var(--text); }
  .rpt-embed td.num { text-align:right; font-variant-numeric:tabular-nums; }
  .rpt-embed tr.subtotal td { font-weight:600; border-top:1px solid var(--border,#aaa); border-bottom:2px solid var(--border,#aaa); background:var(--bg,#f8f8f8); }
  .rpt-embed tr.type_total td { font-weight:700; background:var(--bg,#efefef); }
  .rpt-embed tr.total td { font-weight:700; font-size:11pt; border-top:2px solid var(--text,#1a1a1a); border-bottom:3px double var(--text,#1a1a1a); background:var(--bg,#f0f0f0); }
  .rpt-embed tr.section-header td { font-weight:700; font-size:10pt; text-transform:uppercase; letter-spacing:0.05em; color:var(--text-muted,#444); padding-top:16px; border-bottom:none; background:none; }
  .rpt-embed tr.zero td.num { color:var(--text-faint,#bbb); }
  .rpt-embed .footer { margin-top:32px; padding-top:12px; border-top:1px solid var(--border,#ddd); font-size:9pt; color:var(--text-muted,#888); }
  .rpt-embed-msg { padding:2rem; color:var(--text-muted,#888); }
</style>
</head>
<body>${navBar(company, activeKey)}
<div class="page" style="display:flex; flex-direction:column; height:100%; padding:0; overflow:hidden; max-width:none;">
  <div class="header" style="flex-shrink:0; padding:2.25rem 3rem 0;">
    <h1>\u{1F4C8} ${esc(pageTitle)}</h1>
  </div>

  <div class="tabs" id="rpt-tabs">
    ${tabsHtml}
  </div>

  <div class="tb-controls-row" style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:0.75rem 3rem; border-bottom:1px solid var(--border,#e8e8e8); flex-shrink:0;">
    ${showComparison ? `<button class="tb-toggle-btn" id="rpt-mom" onclick="fbToggleComparison('mom')" title="Month-over-month">MoM</button>
    <button class="tb-toggle-btn" id="rpt-yoy" onclick="fbToggleComparison('yoy')" title="Year-over-year">YoY</button>` : ''}
  </div>

  <div style="flex:1; overflow:auto; min-height:0; background:var(--bg,#f0f0f0); padding:1rem;">
    <div id="report-body" class="rpt-embed"><p class="rpt-embed-msg">Select a report…</p></div>
  </div>
</div>
${layoutEnd()}
<script>
(function() {
  var company = ${JSON.stringify(company)};

  /* ── State ── */
  var RPT_META = ${JSON.stringify(rptMeta)};
  var REPORT_IDS = ${JSON.stringify(pageReports.map(r => r.id))};
  var currentType = REPORT_IDS[0] || '';
  /* Handle ?t= URL param (drill-through, e.g. from payables/aging) */
  var urlParams = new URLSearchParams(window.location.search);
  var drillThrough = !!urlParams.get('t');
  if (drillThrough && REPORT_IDS.indexOf(urlParams.get('t')) >= 0) {
    currentType = urlParams.get('t'); localStorage.setItem('fb-rpt-type', currentType);
  } else {
    var stored = localStorage.getItem('fb-rpt-type');
    if (stored && REPORT_IDS.indexOf(stored) >= 0) currentType = stored;
  }
  var drillAccount = urlParams.get('account') || '';

  var currentStep = localStorage.getItem('fb-rpt-step') || '';

  /* ── Tab strip ── */
  function paintTabs() {
    document.querySelectorAll('#rpt-tabs .tab').forEach(function(el) {
      el.classList.toggle('active', el.getAttribute('data-type') === currentType);
    });
  }
  paintTabs();

  /* ── MoM/YoY buttons: enable only for multiperiod reports (registry) ── */
  function updateStepButtons() {
    var momBtn = document.getElementById('rpt-mom');
    var yoyBtn = document.getElementById('rpt-yoy');
    if (!momBtn && !yoyBtn) return; /* this page renders no comparison chrome at all */
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
  function applyReportRelevance() {
    if (!currentType || !RPT_META[currentType]) return;
    FB.period.setRelevance(RPT_META[currentType].needsStart ? 'range' : 'asOf');
  }
  if (currentType) applyReportRelevance();

  /* ── Wire FB.period — report reloads when the global period changes ── */
  FB.period.onChange(function () { fbLoadReport(); });

  /* ── Helpers ── */
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

  /* ── Public handlers ── */
  window.fbSelectType = function(id) {
    if (!id || id === currentType) return;
    currentType = id;
    localStorage.setItem('fb-rpt-type', currentType);
    paintTabs();
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

  /* ── Fragment fetch + per-URL cache ──────────────────────────────────────
     Fetches the report's full standalone page and extracts its .page element
     client-side (DOMParser) rather than embedding it in an <iframe> — no
     nested-document navigation, no duplicate <head>/CSS parse, and a plain
     in-memory cache keyed by the exact request URL means revisiting an
     already-fetched type+period+step combination renders instantly.
     docs/ia-restructure-3-spec.md §1. */
  var _fragCache = {};
  var _reqSeq = 0;

  // Reports whose embedded <script> is load-bearing for content (not just
  // filter/sort interactivity) and/or calls FB.list.create()/FB.keys — those
  // scripts were written for an isolated iframe with its OWN independent FB
  // instance; executing them in this host page's shared scope collides with
  // the host's live FB.period/FB.keys state (confirmed: broke period
  // resolution app-wide). Confirmed by inspecting each report's actual server
  // response for a real company: 'voucher-register' (Transactions), 'journal'
  // (Line items), and (in payables.js) 'ap-aging' all ship an EMPTY
  // <tbody></tbody> populated entirely by FB.list.create().load() — no
  // server-rendered fallback, so the tab is silently empty (not just
  // non-interactive) without that script running. 'gl' (General Ledger)
  // joined this set 2026-08-30 when it was rewritten onto FB.list (native
  // column-header account filtering, replacing its old bespoke search box) —
  // it now needs FB.list.create() to run for the same reason. These four
  // keep the old isolated <iframe> mechanism; every other report type uses
  // the fetch+cache fragment loader.
  var IFRAME_REPORTS = ['voucher-register', 'journal', 'gl'];

  function renderFragment(pageOuterHtml) {
    document.getElementById('report-body').innerHTML = pageOuterHtml;
  }

  // Reports with their OWN internal scrolling container (currently just 'gl',
  // for its sticky column headers) get a FIXED-height iframe instead of the
  // auto-grow treatment below — auto-growing that iframe while its own CSS
  // sizes a child element off 100vh (which inside an iframe means THAT
  // iframe's own height) is a resize feedback loop: resize the iframe →
  // its internal 100vh changes → the child's max-height changes → body's
  // scrollHeight changes → the ResizeObserver fires → resize the iframe
  // again. Confirmed live as the cause of GL's slow, multi-scrollbar render.
  var FIXED_HEIGHT_IFRAME_REPORTS = ['gl'];

  function renderIframe(url) {
    var container = document.getElementById('report-body');
    var fixed = FIXED_HEIGHT_IFRAME_REPORTS.indexOf(currentType) >= 0;
    // Fixed-height reports: size to the ACTUAL available space (this
    // container's own clientHeight, measured at render time), not a
    // calc(100vh - Npx) guess. A viewport-relative guess is routinely taller
    // than what's really left after the page's own chrome (topbar, tabs,
    // controls row) — the iframe then overflows ITS OWN parent, forcing that
    // parent's overflow:auto to scroll too. That was scrollbar #3: the outer
    // page scrolling around an iframe that didn't actually fit, on top of
    // the iframe's own internal table-wrap scroll.
    var fixedHeightCss = 'height:200px;';
    if (fixed) {
      // container (#report-body) itself has no fixed height (auto — sized to
      // its own content); the definite, flex-computed height is its PARENT
      // (the scrolling wrapper div reports-hub.js's own template wraps this
      // container in), so that's what must be measured, not container itself.
      var scrollParent = container.parentElement;
      // -32 for that wrapper's own 1rem top+bottom padding (its clientHeight
      // includes the padding area, but #report-body sits inside it).
      var avail = (scrollParent ? scrollParent.clientHeight - 32 : 0) || (window.innerHeight - container.getBoundingClientRect().top - 16);
      fixedHeightCss = 'height:' + Math.max(avail, 200) + 'px;';
    }
    container.innerHTML = '<iframe id="rpt-iframe" src="' + url.replace(/"/g, '&quot;')
      + '" style="border:none;width:100%;' + fixedHeightCss
      + 'display:block;background:#fff"></iframe>';
    var frame = document.getElementById('rpt-iframe');
    if (fixed) {
      // Fixed height + the report's own internal scroll — no resize logic
      // needed, but it's still an isolated iframe with its own independent
      // FB instance (see the module comment above): without this, every FB
      // binding inside it appears dead to the human.
      frame.onload = function () {
        if (window.FB && FB.util && FB.util.forwardIframeKeys) FB.util.forwardIframeKeys(frame);
      };
      return;
    }
    // Auto-grow to content height so the report just prints downward inside
    // the host page's own scroll — no second, nested scrollbar inside a
    // height-clamped iframe cutting content off. A ResizeObserver (not a
    // one-shot resize on load) is required: these reports populate their
    // table via their OWN async script (e.g. journal.list/bill.list calls)
    // that resolves well after the load event fires — a single load-time
    // measurement captures the still-empty shell's height, which is exactly
    // what produced the "still cut off" report despite the earlier fix.
    frame.onload = function() {
      try {
        if (window.FB && FB.util && FB.util.forwardIframeKeys) FB.util.forwardIframeKeys(frame);
        var doc = frame.contentWindow.document;
        function resize() {
          var h = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight);
          frame.style.height = h + 'px';
        }
        resize();
        var ro = new ResizeObserver(resize);
        ro.observe(doc.body);
      } catch (e) {}
    };
  }

  function renderMessage(msg, isErr) {
    var el = document.getElementById('report-body');
    el.innerHTML = '<p class="rpt-embed-msg"' + (isErr ? ' style="color:#c0392b"' : '') + '>' + msg.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</p>';
  }

  var _rptLoadPending = false;
  var _doLoadReport = function() {
    var st = FB.period.get();
    var end = st.end;
    localStorage.setItem('fb-rpt-type', currentType);
    updateDownloadHooks();
    if (!end) { renderMessage('Select a period first.'); return; }
    var url = buildReportUrl();
    if (!url) { renderMessage('Select a report and date range first.'); return; }

    if (IFRAME_REPORTS.indexOf(currentType) >= 0) { renderIframe(url); return; }

    if (_fragCache[url]) { renderFragment(_fragCache[url]); return; }

    var mySeq = ++_reqSeq;
    renderMessage('Loading\\u2026');
    fetch(url).then(function(resp) {
      var ct = resp.headers.get('content-type') || '';
      return resp.text().then(function(text) { return { ok: resp.ok, ct: ct, text: text }; });
    }).then(function(r) {
      if (mySeq !== _reqSeq) return; /* a newer tab/period switch superseded this request */
      if (!r.ok || r.ct.indexOf('application/json') === 0) {
        var msg = 'Load failed';
        try { msg = JSON.parse(r.text).error || msg; } catch(e) {}
        renderMessage(msg, true);
        return;
      }
      var doc = new DOMParser().parseFromString(r.text, 'text/html');
      var pageEl = doc.querySelector('.page');
      if (!pageEl) { renderMessage('Report returned no content.', true); return; }
      var outer = pageEl.outerHTML;
      _fragCache[url] = outer;
      renderFragment(outer);
    }).catch(function(err) {
      if (mySeq !== _reqSeq) return;
      renderMessage('Load failed: ' + (err && err.message ? err.message : 'network error'), true);
    });
  };
  window.fbLoadReport = function() {
    if (_rptLoadPending) return;
    _rptLoadPending = true;
    setTimeout(function () { _rptLoadPending = false; _doLoadReport(); }, 0);
  };

  /* ── PDF / CSV — feed the unified topbar download icon ────────────────────
     ia-restructure-3-spec.md §6.3/§6.4. window.__fbDownloadPdfUrl/Csv are
     functions so they always reflect the CURRENT tab/period at click time,
     re-set here on every tab switch and initial load. SIE is not this
     page's concern any more — it's handled globally (fb-core.js), company+
     period scoped, not tied to a report type. */
  // Iframe-based reports (§1 "Prerequisite") hold their full row data (never
  // blanked for atomic-grouping display) in a predictably-named global
  // inside the iframe's OWN window — read it directly (same-origin) rather
  // than scraping the DOM, which can't cross the iframe boundary anyway and
  // would re-export the display-blanked values even if it could.
  var IFRAME_ROW_VARS = { 'voucher-register': 'VR_ROWS', 'journal': 'JL_ROWS', 'gl': 'GL_ROWS' };

  function _rowsToCsv(rows) {
    if (!rows || !rows.length) return null;
    // Drop internal bookkeeping fields (_key and friends, batch_id — an
    // internal id, not user-facing data); everything else is exported.
    var keys = Object.keys(rows[0]).filter(function (k) { return k.charAt(0) !== '_' && k !== 'batch_id'; });
    var header = keys.map(function (k) { return '"' + k.replace(/_/g, ' ').replace(/\\b\\w/g, function (c) { return c.toUpperCase(); }) + '"'; }).join(',');
    var lines = [header];
    rows.forEach(function (r) {
      lines.push(keys.map(function (k) {
        return '"' + String(r[k] == null ? '' : r[k]).replace(/"/g, '""') + '"';
      }).join(','));
    });
    return lines.join('\\n');
  }

  function _fragmentCsv() {
    var body = document.getElementById('report-body');
    var tables = body ? body.querySelectorAll('table') : [];
    if (!tables.length) return null;
    var lines = [];
    tables.forEach(function (tbl) {
      tbl.querySelectorAll('tr').forEach(function (tr) {
        var cells = Array.from(tr.querySelectorAll('th,td'));
        if (cells.length) lines.push(cells.map(function (c) {
          return '"' + c.textContent.trim().replace(/"/g, '""') + '"';
        }).join(','));
      });
      lines.push('');
    });
    return lines.join('\\n');
  }

  function updateDownloadHooks() {
    var st = FB.period.get();
    var suffix = currentType + (st.start ? '_' + st.start : '') + (st.end ? '_' + st.end : '');
    window.__fbDownloadPdfUrl = function () { return buildReportUrl(); };
    if (IFRAME_ROW_VARS[currentType]) {
      var varName = IFRAME_ROW_VARS[currentType];
      window.__fbDownloadCsv = function () {
        var frame = document.getElementById('rpt-iframe');
        var rows = frame && frame.contentWindow ? frame.contentWindow[varName] : null;
        var csv = _rowsToCsv(rows);
        return csv ? { filename: suffix + '.csv', csv: csv } : null;
      };
    } else {
      window.__fbDownloadCsv = function () {
        var csv = _fragmentCsv();
        return csv ? { filename: suffix + '.csv', csv: csv } : null;
      };
    }
  }

  /* ── FB.form (K3b, keyboard-ux-spec §8) — the filter bar is a header-only
     form: j/k rows, h/l cells, i/Enter edit, Esc exit. MoM/YoY are h/l-
     navigable toggle-button cells (only present when showComparison); ~ flips
     the FOCUSED comparison button only (re-toggle returns to none —
     fbToggleComparison's own semantics), never a group cycle (magnus
     2026-07-28). Report-type tabs are mouse-only — no h/l tab-cycling
     precedent exists elsewhere in the app (Payables/Accounting tabs are
     click-only too), and the frozen-verb-surface doctrine (roadmap §0q)
     means a new tab-cycling verb isn't added speculatively here.
     Download's own j/k/Enter/Esc mini-scope and its d binding are GONE —
     the download control moved to the global topbar icon (fb-core.js,
     ia-restructure-3-spec.md §6.3), which is mouse-only like every other
     topbar icon (notifications, theme, help); no replacement d binding
     was added here or globally — that would be a NEW keyboard verb under
     the frozen-verb-surface doctrine, not a like-for-like move, so it
     needs its own explicit ratification if wanted. ── */

  var rptForm = FB.form.create({
    formId: 'reports',
    onCommit: function () { fbLoadReport(); },
    zones: [
      { id: 'filters', rows: function () { return [document.querySelector('.tb-controls-row')]; },
        cells: function (row) {
          return [
            document.getElementById('rpt-mom'),
            document.getElementById('rpt-yoy')
          ].filter(Boolean);
        } }
    ],
    extraBindings: function (api) {
      return [
        { key: '~', mode: 'NORMAL', hint: 'comparison', hintBar: true, run: function () {
            var el = api.cellEl();
            if (el && (el.id === 'rpt-mom' || el.id === 'rpt-yoy')) el.click();
          } }
      ];
    }
  });
  FB.keys.renderHints('reports', document.getElementById('sb-hints'), { layout: 'list' });

  /* Initial load */
  fbLoadReport();

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
  return buildHubPage(req, res, { pageKey: 'statements', pageTitle: 'Statements', activeKey: 'statements', showComparison: true });
}

/**
 * Journal hub — ledger/transactional tooling (Transactions, Line items,
 * Trial Balance, General Ledger). Renamed from Books, Integrity relocated to
 * Accounting, SIE export moved here — docs/ia-restructure-3-spec.md §3.2.
 * No MoM/YoY chrome — every report on this page is multiperiod:false.
 */
async function handleJournalHubPage(req, res) {
  return buildHubPage(req, res, {
    pageKey: 'journal', pageTitle: 'Journal', activeKey: 'journal', showComparison: false,
    labelOverrides: { 'voucher-register': 'Transactions', 'journal': 'Line items' }
  });
}

module.exports = { handleStatementsHubPage, handleJournalHubPage, isSieExportEnabled };
