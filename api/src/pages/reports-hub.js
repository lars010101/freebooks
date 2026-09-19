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
  .tabs { display:flex; gap:0; border-bottom:2px solid var(--accent); padding:0 3rem; }
  .tab { padding:8px 20px; cursor:pointer; font-weight:600; font-size:0.8125rem; color:var(--text-muted); border-bottom:3px solid transparent; margin-bottom:-2px; }
  .tab.active { color:var(--accent); border-bottom-color:var(--accent); }
  /* Report fragment styling — mirrors reports/render.js htmlPage()'s embedded
     <style> block (that CSS never ships to the client here; only the .page
     element's markup does), made theme-aware via the app's CSS vars. White
     card on the gray wrapper below — the QBO/Xero convention for rendered
     financial statements (magnus, 2026-09-17: "go towards the industry
     standard, benchmark QBO/Xero"). */
  /* Whole-page scroll (magnus, 2026-09-18: "I much prefer the scrolling
     behavior illustrated in Payables/Bills: the entire page header scrolls
     away and column header row sticks only just below the top bar") —
     also fixes a real bug the previous approach had: a bounded scroll box
     confined to just .table-wrap, which doesn't exist at all for non-wide
     reports (PL/BS/CF render their table directly into .page, no wrapper —
     see htmlPage() in reports/render.js), silently broke scrolling for
     Statements entirely. Bills never had either problem because it never
     tried to carve out a special scroll region in the first place — it
     just drops content into #page-main (common.css/common.js's own single
     shared scroll container) and lets it be the only overflow-establishing
     ancestor in the whole chain, so there's never more than one candidate
     for position:sticky to anchor against. Matching that here: no
     height:100%/flex-cascade tricks, .table-wrap only needs overflow-x for
     the wide reports (TB/Integrity), and #page-main does the rest. */
  .rpt-embed { background:var(--surface); border-radius:8px; }
  .rpt-embed .page { padding:24px; max-width:none; }
  .rpt-embed .page.wide .table-wrap { overflow-x:auto; }
  .rpt-embed .page.wide th { white-space:nowrap; }
  /* Company/report-title/period repeats page chrome the app already shows —
     hidden on screen (ia-restructure-3-spec.md §6.2). PDF export opens the
     report's own standalone URL raw, not this fragment, so it keeps its
     header regardless (reports/render.js's own per-report stylesheet). */
  .rpt-embed .header { display:none; }
  .rpt-embed .company { font-size:1rem; font-weight:700; color:var(--text); }
  .rpt-embed .report-title { font-size:0.875rem; color:var(--text-muted); margin-top:4px; }
  .rpt-embed .period { font-size:0.8125rem; color:var(--text-muted); margin-top:2px; }
  /* GL/Journal/Voucher Register fragments have a sticky <thead th> (see the
     .rpt-embed table.edit-table thead th rule below) — border-collapse:
     collapse + position:sticky on th is a documented cross-browser bug
     where the row scrolling underneath can paint through/above the sticky
     header at the boundary (magnus, 2026-09-17). border-spacing:0 keeps
     cells touching exactly as collapse did. */
  .rpt-embed table { width:100%; border-collapse:separate; border-spacing:0; margin-top:8px; }
  .rpt-embed th { text-align:left; font-size:0.75rem; text-transform:uppercase; letter-spacing:0.05em; color:var(--text-muted); border-bottom:1px solid var(--border); padding:6px 8px; }
  /* GL/Journal/Voucher Register fragments carry <table class="edit-table">
     (FB.list-editable) — common.css's shared sticky-header rule paints
     that th gray (.edit-table thead th { background:var(--bg) }, magnus
     2026-09-16), which is MORE specific than .rpt-embed th above and wins
     regardless of source order, leaving the header row gray against this
     card's white. Out-specified here rather than guessed at (magnus,
     2026-09-17: "don't act blindly, if it should, it should"). */
  /* A large upward box-shadow used to sit here (magnus, 2026-09-17) as a
     band-aid over the sticky-header ghosting bug that came from the old
     bounded-scroll-box architecture. Removed (2026-09-18): once this page
     switched to whole-page scroll (a single #page-main, same model as
     Bills — see the comment above .rpt-embed), the H1 title/tabs sit in
     the SAME scrollable region as the report body, so that shadow started
     painting a solid white bar over them once the sticky header engaged
     ("a white bar has appeared high on the page... hiding partly
     'Journal'"). The ghosting bug it covered for doesn't exist in this
     architecture in the first place (nothing left to cover). */
  .rpt-embed table.edit-table thead th { background:var(--surface); }
  /* common.css's own th.fb-th-filterable padding-right reservation (for the
     ≡ filter icon) is scoped to .data-table only — GL/Journal/Voucher
     Register use .edit-table, so their OWN standalone pages carry a local
     override for this (reports/render.js), which — like every other rule
     in that <style> block — never survives the DOMParser fragment
     extraction into this embedded view. Without it the icon renders
     overlapping the header text itself, with no room reserved (magnus,
     2026-09-18: "unable to search for a transaction or debit/credit of a
     specific amount" — the filter existed, it just wasn't usably visible). */
  .rpt-embed th.fb-th-filterable { padding-right: 24px; }
  .rpt-embed th.num { text-align:right; }
  .rpt-embed td { padding:5px 8px; border-bottom:1px solid var(--border); vertical-align:top; color:var(--text); }
  .rpt-embed td.num { text-align:right; font-variant-numeric:tabular-nums; }
  .rpt-embed tr.subtotal td { font-weight:600; border-top:1px solid var(--text-faint); border-bottom:2px solid var(--text-faint); background:var(--bg); }
  .rpt-embed tr.type_total td { font-weight:700; border-top:1px solid var(--text-faint); background:var(--bg); }
  .rpt-embed tr.total td { font-weight:700; font-size:0.875rem; border-top:3px solid var(--text); border-bottom:3px double var(--text); background:var(--bg); }
  .rpt-embed tr.section-header td { font-weight:700; font-size:0.8125rem; text-transform:uppercase; letter-spacing:0.05em; color:var(--text-muted); padding-top:16px; border-bottom:none; background:none; }
  .rpt-embed tr.zero td.num { color:var(--text-faint); }
  /* .doc-link's own rule lives in the report's <style> (render.js htmlPage())
     — stripped along with the rest of <head> by the DOMParser fragment
     extraction above, same reason every other rpt-embed rule here exists.
     Without this the class renders with no CSS at all: browser-default blue
     underline, not the quiet link the rest of the app uses. */
  .rpt-embed .doc-link { color:var(--accent); text-decoration:none; font-weight:500; }
  .rpt-embed .doc-link:hover { text-decoration:underline; }
  .rpt-embed .footer { margin-top:24px; padding-top:12px; border-top:1px solid var(--border); font-size:0.75rem; color:var(--text-muted); }
  .rpt-embed-msg { padding:2rem; color:var(--text-muted); }
  /* MoM/YoY moved from a persistent controls-row above the tabs to a single
     cycling icon living directly in the Amount/Balance column header, only
     for the 3 reports that actually support it (magnus, 2026-09-18: "They
     only relevant for PL, CF and BS... attach some action to the
     AMOUNT/(BALANCE) column header... a single icon, which cycles between
     single period, MoM and YoY... not visible on a PDF export"). PDF export
     opens this report's own standalone URL fresh in a new tab (fb-core.js's
     _dlExportPdf, reports/render.js's own server-rendered HTML) — this icon
     is a client-side DOM insertion into the embedded fragment only, so it
     was never part of that server-rendered page to begin with; @media
     print below is belt-and-suspenders in case this hub page itself is
     ever printed directly. th's own uppercase/letter-spacing is reset back
     to normal for the icon's own tooltip/rendering. */
  .rpt-period-toggle {
    display:inline-flex; align-items:center; justify-content:center;
    width:20px; height:20px; margin-left:8px; padding:0; vertical-align:middle;
    border:1px solid var(--border); border-radius:4px; background:var(--surface);
    color:var(--text-muted); cursor:pointer; text-transform:none; letter-spacing:normal;
  }
  .rpt-period-toggle:hover { background:var(--bg); color:var(--text); }
  .rpt-period-toggle.rpt-period-active { background:var(--toggle-on); border-color:var(--toggle-on-border); color:var(--toggle-on-text); }
  @media print { .rpt-period-toggle { display:none; } }
</style>
</head>
<body>${navBar(company, activeKey)}
<div class="page" style="padding:0; max-width:none;">
  <div class="header" style="padding:2.25rem 3rem 0;">
    <h1>\u{1F4C8} ${esc(pageTitle)}</h1>
  </div>

  <div class="tabs" id="rpt-tabs">
    ${tabsHtml}
  </div>

  <div style="background:var(--bg); padding:1rem;">
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

  /* ── Period-comparison icon ───────────────────────────────────────────────
     Lives in the Amount/Balance column header of the report itself, only
     for the 3 reports that support it (PL/CF/BS), never rendered at all for
     anything else. One icon, not two buttons (magnus, 2026-09-18) — clicking
     it cycles single period → MoM → YoY → single period. The <button>
     element is created ONCE and moved (not recreated) into whichever
     report's header currently wants it, so its identity, its onclick
     handler, and the FB.form 'filters' zone that reaches it via h/l + ~ are
     all completely unaffected by where it currently lives. */
  var CALENDAR_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">'
    + '<rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" stroke-width="1.8"/>'
    + '<path d="M3 9.5h18M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'
    + '</svg>';
  var STEP_TITLES = { '': 'Single period — click for month-over-month', mom: 'Month-over-month — click for year-over-year', yoy: 'Year-over-year — click for single period' };
  var _comparisonEl = null;
  function ensureComparisonEl() {
    if (_comparisonEl) return _comparisonEl;
    var btn = document.createElement('button');
    btn.className = 'rpt-period-toggle'; btn.id = 'rpt-period-toggle';
    btn.innerHTML = CALENDAR_SVG;
    btn.onclick = function () { fbCycleComparison(); };
    _comparisonEl = btn;
    return _comparisonEl;
  }

  function updateStepButtons() {
    var supported = !!(RPT_META[currentType] && RPT_META[currentType].multiperiod);
    if (!supported) { currentStep = ''; localStorage.setItem('fb-rpt-step', ''); }
    var btn = ensureComparisonEl();
    btn.title = STEP_TITLES[currentStep] || STEP_TITLES[''];
    btn.classList.toggle('rpt-period-active', currentStep === 'mom' || currentStep === 'yoy');
  }

  /* Moves (never clones) the icon into the current report's rightmost header
     cell — Code/Description/Amount|Balance for a single period, or
     Code/Description/<period1>/<period2>/... for a MoM/YoY comparative view
     (renderComparative(), reports/render.js) — the last <th> is always the
     one numeric value column in both shapes. Called after every fragment
     render; a no-op (icon stays wherever it last was, detached/invisible)
     for reports that don't support comparison at all. */
  function attachComparisonControls() {
    var supported = !!(RPT_META[currentType] && RPT_META[currentType].multiperiod);
    if (!supported) return;
    var th = document.querySelector('#report-body thead tr th:last-child');
    if (!th) return;
    th.appendChild(ensureComparisonEl());
    updateStepButtons();
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

  window.fbCycleComparison = function() {
    if (!(RPT_META[currentType] && RPT_META[currentType].multiperiod)) return;
    currentStep = currentStep === '' ? 'mom' : currentStep === 'mom' ? 'yoy' : '';
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

  // De-iframe migration (2026-09-16): 'voucher-register'/'journal'/'gl' used
  // to need a real isolated <iframe> — their embedded <script> is load-
  // bearing for content (FB.list.create().load() populates an otherwise
  // EMPTY <tbody>, no server-rendered fallback), and running that script in
  // this host page's own shared FB.keys/window.__fbFlags used to corrupt
  // both (verified root cause, fixed the same day: window.__fbFlags was a
  // bare replacement instead of a merge, and each report's FB.list
  // registered active():true unconditionally instead of gating on its own
  // visibility). With those fixed at the source (reports/render.js), the
  // fragment loader below can run their script directly — same path every
  // other report type already used, no report type is special-cased here
  // anymore.
  function renderFragment(pageOuterHtml) {
    var container = document.getElementById('report-body');
    container.innerHTML = pageOuterHtml;
    if (window.FB && FB.util && FB.util.execInlineScripts) FB.util.execInlineScripts(container);
    attachComparisonControls();
  }

  function renderMessage(msg, isErr) {
    var el = document.getElementById('report-body');
    el.innerHTML = '<p class="rpt-embed-msg"' + (isErr ? ' style="color:var(--danger)"' : '') + '>' + msg.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</p>';
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
  // These 3 report types hold their full row data (never blanked for
  // atomic-grouping display) in a predictably-named global — read it
  // directly rather than scraping the DOM, which would re-export the
  // display-blanked values even if it were reliable. Pre-de-iframe-
  // migration (2026-09-16) this lived inside an isolated <iframe>'s own
  // window and needed frame.contentWindow[varName]; now that these 3 run
  // in this page's own shared scope, it's just window[varName].
  var ROW_VARS = { 'voucher-register': 'VR_ROWS', 'journal': 'JL_ROWS', 'gl': 'GL_ROWS' };

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
    if (ROW_VARS[currentType]) {
      var varName = ROW_VARS[currentType];
      window.__fbDownloadCsv = function () {
        var rows = window[varName];
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
     form: j/k rows, h/l cells, i/Enter edit, Esc exit. The period-comparison
     icon is a single h/l-navigable cell (only present at all when the
     current report supports it — PL/CF/BS, never TB/GL/etc.); ~ clicks it,
     which now cycles single period → MoM → YoY → single period
     (fbCycleComparison — magnus, 2026-09-18, superseding the two-button
     "~ flips the FOCUSED button only, never a group cycle" design from
     2026-07-28, which no longer applies now that there's only one cell to
     flip). Report-type tabs are mouse-only — no h/l tab-cycling precedent
     exists elsewhere in the app (Payables/Accounting tabs are click-only
     too), and the frozen-verb-surface doctrine (roadmap §0q) means a new
     tab-cycling verb isn't added speculatively here.
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
      { id: 'filters', rows: function () {
          // No more persistent .tb-controls-row (magnus, 2026-09-18) — the
          // icon lives in the report's own header now, only when attached
          // (multiperiod-supporting report currently selected). getElementById
          // only finds it while attached, so this naturally yields zero rows
          // (nothing to h/l/~ into) exactly when it's not relevant, instead
          // of the old shown-but-disabled state.
          var btn = document.getElementById('rpt-period-toggle');
          return btn ? [btn.closest('tr') || btn] : [];
        },
        cells: function (row) {
          return [document.getElementById('rpt-period-toggle')].filter(Boolean);
        } }
    ],
    extraBindings: function (api) {
      return [
        { key: '~', mode: 'NORMAL', hint: 'comparison', hintBar: true, run: function () {
            var el = api.cellEl();
            if (el && el.id === 'rpt-period-toggle') el.click();
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
