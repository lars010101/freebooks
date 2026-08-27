'use strict';
const { makeQuery, commonStyle, navBar, layoutEnd } = require('./common');
const { reportsByPage } = require('../report-registry');

// Simple TTL cache for dashboard card data (per company, 30s TTL)
const _dashCache = new Map(); // key: company_id, value: { data, expiresAt }
const DASH_CACHE_TTL_MS = 30_000;

async function handleCompanyPage(req, res) {
  const { company } = req.params;
  const query = makeQuery();
  try {
    const [co] = await query(
      `SELECT company_id, company_name FROM companies WHERE company_id = ? LIMIT 1`,
      [company]
    );
    if (!co) return res.status(404).send(`<h1>Company not found: ${company}</h1>`);

    const periods = await query(
      `SELECT period_name, start_date, end_date, locked
       FROM periods WHERE company_id = ?
       ORDER BY start_date DESC`,
      [company]
    );

    const currentPeriod = periods[0];
    const toYMD = d => { if (!d) return ''; const dt = (d instanceof Date) ? d : new Date(d); return dt.toISOString().slice(0, 10); };
    const startDate = currentPeriod ? toYMD(currentPeriod.start_date) : null;
    const endDate = currentPeriod ? toYMD(currentPeriod.end_date) : null;

    // Check cache first
    let cardData = {};
    const cached = _dashCache.get(company);
    if (cached && cached.expiresAt > Date.now()) {
      cardData = cached.data;
    } else {
      // Operational state — workflow status with no report-macro equivalent
      const [ops] = await query(
        `SELECT
          (SELECT COUNT(*) FROM periods WHERE company_id = $1 AND locked = false) as unlocked_count,
          (SELECT COUNT(DISTINCT je.batch_id)
           FROM journal_entries je
           JOIN accounts a ON a.account_code = je.account_code AND a.company_id = je.company_id
           LEFT JOIN reconciliations r ON r.company_id = je.company_id AND r.batch_id = je.batch_id AND r.account_code = je.account_code
           WHERE je.company_id = $1 AND a.cf_category = 'Cash' AND r.batch_id IS NULL) as uncleared_cnt`,
        [company]
      ).catch(() => [{}]);

      // Report figures — MUST come from db/macros.sql so the Dashboard can never
      // diverge from Reports (docs/reports-dashboard-spec.md §2). Side benefit:
      // macros use debit_home/credit_home, fixing the old card query's
      // mixed-transaction-currency sums for multi-currency companies.
      const plRows = (startDate && endDate)
        ? await query(
            `SELECT amount FROM pl($1, $2, $3) WHERE row_type = 'total'`,
            [company, startDate, endDate]
          ).catch(() => [])
        : [];
      const [bank] = await query(
        `SELECT COALESCE(SUM(b.balance), 0) AS bank_balance
         FROM bs($1, DATE '9999-12-31') b
         JOIN accounts a ON a.company_id = $1 AND a.account_code = b.account_code
         WHERE b.row_type = 'account' AND a.cf_category = 'Cash'`,
        [company]
      ).catch(() => [{}]);

      cardData = {
        unlockedCount: Number(ops?.unlocked_count || 0),
        unclearedCount: Number(ops?.uncleared_cnt || 0),
        bankBalance: Number(bank?.bank_balance || 0),
        netIncome: Number(plRows[0]?.amount || 0),
        currentPeriodName: currentPeriod?.period_name || null,
      };
      _dashCache.set(company, { data: cardData, expiresAt: Date.now() + DASH_CACHE_TTL_MS });
    }

    const html = buildCompanyPage(co, cardData);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── HTML builder ──────────────────────────────────────────────────────────────
// Dashboard = operational status page: KPI cards + alerts with drill-through,
// plus grouped report links into the hub. No report parameters, no report
// rendering here — that lives in the Reports hub (reports-dashboard-spec §2/§3).
function buildCompanyPage(co, stats = {}) {
  const fmt = n => `${n < 0 ? '-' : ''}${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const reportGroups = reportsByPage('statements').length > 0
    ? `<div class="dash-rpt-group">
      <span class="dash-rpt-cat">Statements</span>
      <span class="dash-rpt-links">
        ${reportsByPage('statements').map(r => `<a class="dash-rpt-link" href="/${co.company_id}/statements?t=${r.id}">${r.label.replace(/&/g, '&amp;')}</a>`).join('\n        ')}
      </span>
    </div>
    <div class="dash-rpt-group">
      <span class="dash-rpt-cat">Books</span>
      <span class="dash-rpt-links">
        ${reportsByPage('books').map(r => `<a class="dash-rpt-link" href="/${co.company_id}/books?t=${r.id}">${r.label.replace(/&/g, '&amp;')}</a>`).join('\n        ')}
      </span>
    </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${co.company_name} — freeBooks</title>
${commonStyle()}
<style>
  .dashboard-cards { display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin-bottom:28px; }
  .dash-card { background:var(--surface,#f8f9fa); border:1px solid var(--border,#e8e8e8); border-radius:8px; padding:16px 18px; text-decoration:none; color:inherit; display:block; cursor:pointer; transition:box-shadow .15s; }
  .dash-card:hover { box-shadow:0 2px 8px rgba(0,0,0,.1); }
  .dash-card .card-icon { font-size:1.5rem; margin-bottom:6px; display:block; }
  .dash-card .card-label { font-size:0.75rem; color:var(--text-muted,#888); font-weight:700; text-transform:uppercase; letter-spacing:.06em; margin-bottom:4px; display:block; }
  .dash-card .card-value { font-size:1.5rem; font-weight:700; color:var(--text,#1a1a1a); display:block; }
  .dash-rpt-group { display:flex; align-items:baseline; gap:14px; padding:10px 0; border-bottom:1px solid var(--border,#e8e8e8); }
  .dash-rpt-group:last-child { border-bottom:none; }
  .dash-rpt-cat { font-size:0.75rem; color:var(--text-muted,#888); font-weight:700; text-transform:uppercase; letter-spacing:.06em; min-width:160px; flex-shrink:0; }
  .dash-rpt-links { display:flex; flex-wrap:wrap; gap:8px; }
  .dash-rpt-link { padding:6px 14px; border:1px solid var(--border,#ccc); border-radius:4px; background:var(--surface,#f5f5f5); font-size:0.875rem; text-decoration:none; color:inherit; cursor:pointer; }
  .dash-rpt-link:hover { background:var(--bg,#e8e8e8); }
  @media (max-width:700px) {
    .dashboard-cards { grid-template-columns:repeat(2,1fr); }
    .dash-rpt-group { flex-direction:column; gap:8px; }
    .dash-rpt-cat { min-width:0; }
  }
</style>
</head>
<body>${navBar(co.company_id, 'dashboard')}
<div class="page">
  <div class="header">
    <h1>${co.company_name}</h1>
    <p class="sub">${co.company_id}${stats.currentPeriodName ? ' · ' + stats.currentPeriodName : ''}</p>
  </div>

  <div class="dashboard-cards">
    <a class="dash-card" href="/${co.company_id}/settings?tab=periods">
      <span class="card-icon">📅</span>
      <span class="card-label">Unlocked yr</span>
      <span class="card-value" style="color:${stats.unlockedCount <= 1 ? '#2a8a2a' : stats.unlockedCount === 2 ? '#cc7700' : '#cc2222'}">${stats.unlockedCount}</span>
    </a>
    <a class="dash-card" href="/${co.company_id}/bank?mode=uncleared">
      <span class="card-icon">⚠</span>
      <span class="card-label">Uncleared tx</span>
      <span class="card-value" style="color:${stats.unclearedCount > 0 ? '#cc2222' : '#2a8a2a'}">${stats.unclearedCount}</span>
    </a>
    <a class="dash-card" href="/${co.company_id}/bank">
      <span class="card-icon">🏦</span>
      <span class="card-label">Bank Balance</span>
      <span class="card-value">${fmt(stats.bankBalance)}</span>
    </a>
    <a class="dash-card" href="/${co.company_id}/statements?t=pl">
      <span class="card-icon">📈</span>
      <span class="card-label">P&amp;L</span>
      <span class="card-value" style="color:${stats.netIncome >= 0 ? '#2a8a2a' : '#cc2222'}">${fmt(stats.netIncome)}</span>
    </a>
  </div>

  <h2>Reports</h2>
  <div class="dash-reports">
    ${reportGroups}
  </div>
</div>
<script>
  localStorage.setItem('freebooks_company', '${co.company_id}');
  // K5: dashboard keys — FB.nav over the stat cards + report links (the only
  // interactive surface). 2026-07-28: spatial 2D grid (magnus) — cards are
  // chunked by visual row, each report group is a row of links; j/k move
  // across rows (column preserved), h/l within a row, Enter follows the
  // anchor exactly like the mouse, Esc clears.
  (function () {
    var dashNav = FB.nav.create({
      // K5: fb-nav-focus — a visible ring class for non-table FB.nav surfaces
      // (dashboard cards/report links). The default 'nav-row-focus' rule is
      // tr-scoped (tr.nav-row-focus > td), so it never painted on <a> cards;
      // fb-nav-focus is a strong outline/box-shadow ring that works for the
      // dashboard AND any future non-tr FB.nav consumer. A CSS class is the
      // selector (NORMAL-mode doctrine: no DOM focus grabbed — Enter follows
      // the anchor via el.click(), never .focus()).
      focusClass: 'fb-nav-focus',
      grid: function () {
        var cards = Array.from(document.querySelectorAll('.dash-card')).filter(function (el) { return el.offsetParent !== null; });
        var byTop = [];
        cards.forEach(function (el) {
          var row = null;
          for (var i = 0; i < byTop.length; i++) { if (Math.abs(byTop[i].top - el.offsetTop) < 4) { row = byTop[i]; break; } }
          if (row) row.els.push(el); else byTop.push({ top: el.offsetTop, els: [el] });
        });
        byTop.sort(function (a, b) { return a.top - b.top; });
        var groups = byTop.map(function (r) { return r.els; });
        Array.from(document.querySelectorAll('.dash-rpt-group')).forEach(function (g) {
          var links = Array.from(g.querySelectorAll('.dash-rpt-link')).filter(function (el) { return el.offsetParent !== null; });
          if (links.length) groups.push(links);
        });
        return groups;
      }
    });
    var anyDashEl = function () { return document.querySelector('.dash-card, .dash-rpt-link'); };
    FB.keys.register('dashboard', {
      bindings: [
        { key: 'j', mode: 'NORMAL', hint: 'navigate', hintBar: true, paletteEligible: false,
          swallow: function () { return dashNav.current() || anyDashEl(); },
          run: function () { dashNav.move(1); } },
        { key: 'k', mode: 'NORMAL', hint: 'navigate', hintBar: true, paletteEligible: false,
          swallow: function () { return dashNav.current() || anyDashEl(); },
          run: function () { dashNav.move(-1); } },
        { key: 'h', mode: 'NORMAL', hint: 'left', hintBar: true, paletteEligible: false,
          swallow: function () { return dashNav.current() || anyDashEl(); },
          run: function () { dashNav.moveH(-1); } },
        { key: 'l', mode: 'NORMAL', hint: 'right', hintBar: true, paletteEligible: false,
          swallow: function () { return dashNav.current() || anyDashEl(); },
          run: function () { dashNav.moveH(1); } },
        { key: 'Enter', mode: 'NORMAL', hint: 'open', hintBar: true, paletteEligible: false,
          swallow: function () { return dashNav.current(); },
          run: function () { var el = dashNav.current(); if (el) el.click(); } },
        { key: 'Escape', mode: 'NORMAL', hint: 'clear focus', hintBar: true, paletteEligible: false,
          swallow: function () { return !!dashNav.current(); },
          run: function () { dashNav.clear(); } }
      ]
    });
    FB.keys.renderHints('dashboard', document.getElementById('sb-hints'), { layout: 'list' });
  })();
</script>
${layoutEnd()}
</body>
</html>`;
}

module.exports = { handleCompanyPage };
