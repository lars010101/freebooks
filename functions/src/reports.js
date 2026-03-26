/**
 * Skuld — Report generation
 *
 * Generates: Trial Balance, P&L, Balance Sheet, Cash Flow, Dashboard, AP Aging,
 *            VAT Return, Statement of Changes in Equity, Integrity Check
 * All queries run against BigQuery. Results returned to Apps Script for Sheet display.
 */

const { generateVatReturn } = require('./vat');

/**
 * Route report actions.
 */
async function handleReports(ctx, action) {
  switch (action) {
    case 'report.refresh_tb':
      return refreshTrialBalance(ctx);
    case 'report.refresh_pl':
      return refreshPL(ctx);
    case 'report.refresh_bs':
      return refreshBS(ctx);
    case 'report.refresh_cf':
      return refreshCF(ctx);
    case 'report.refresh_dashboard':
      return refreshDashboard(ctx);
    case 'report.refresh_ap_aging':
      return refreshAPAging(ctx);
    case 'report.refresh_vat_return':
      return generateVatReturn(ctx);
    case 'report.refresh_sce':
      return refreshSCE(ctx);
    case 'report.refresh_integrity':
      return refreshIntegrity(ctx);
    default:
      throw Object.assign(new Error(`Unknown report action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

// =============================================================================
// Period detection helpers
// =============================================================================

/**
 * Fetch company FY start/end from the companies table.
 * Returns { fyStartMonth, fyStartDay, fyEndMonth, fyEndDay }.
 * fy_start/fy_end are stored as MM-DD strings (e.g. '02-01', '01-31').
 */
async function getCompanyFY(dataset, companyId) {
  const [rows] = await dataset.query({
    query: `SELECT fy_start, fy_end FROM finance.companies WHERE company_id = @companyId LIMIT 1`,
    params: { companyId },
  });
  if (!rows || rows.length === 0) {
    return { fyStartMonth: 1, fyStartDay: 1, fyEndMonth: 12, fyEndDay: 31 };
  }
  const fy = rows[0];
  // fy_start/fy_end may be DATE objects ({value:'2025-02-01'}) or strings
  const fyStartStr = String(fy.fy_start?.value || fy.fy_start || '2025-01-01');
  const fyEndStr = String(fy.fy_end?.value || fy.fy_end || '2025-12-31');
  // Parse YYYY-MM-DD — extract month and day
  const fsParts = fyStartStr.split('-').map(Number);
  const feParts = fyEndStr.split('-').map(Number);
  const sm = fsParts.length === 3 ? fsParts[1] : fsParts[0];
  const sd = fsParts.length === 3 ? fsParts[2] : fsParts[1];
  const em = feParts.length === 3 ? feParts[1] : feParts[0];
  const ed = feParts.length === 3 ? feParts[2] : feParts[1];
  return { fyStartMonth: sm, fyStartDay: sd, fyEndMonth: em, fyEndDay: ed };
}

/**
 * Get last day of a given month.
 */
function lastDayOfMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

/**
 * Format a date as YYYY-MM-DD.
 */
function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Format period label from date range.
 */
function periodLabel(dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return 'All Time';
  if (!dateFrom) return `As at ${dateTo}`;
  const df = new Date(dateFrom + 'T00:00:00Z');
  const dt = new Date(dateTo + 'T00:00:00Z');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  // Single month
  if (df.getUTCMonth() === dt.getUTCMonth() && df.getUTCFullYear() === dt.getUTCFullYear()) {
    return `${months[df.getUTCMonth()]} ${df.getUTCFullYear()}`;
  }
  // Full year or multi-month
  return `${months[df.getUTCMonth()]} ${df.getUTCFullYear()} – ${months[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
}

/**
 * Detect period type from dateFrom/dateTo and company FY settings.
 * Returns: { type: 'fy'|'quarter'|'month'|'single', periods: [{ dateFrom, dateTo, label }] }
 */
function detectPeriods(dateFrom, dateTo, fy) {
  if (!dateFrom || !dateTo) {
    return { type: 'single', periods: [{ dateFrom: dateFrom || null, dateTo: dateTo || null, label: periodLabel(dateFrom, dateTo) }] };
  }

  const df = new Date(dateFrom + 'T00:00:00Z');
  const dt = new Date(dateTo + 'T00:00:00Z');

  const fromDay = df.getUTCDate();
  const fromMonth = df.getUTCMonth() + 1; // 1-based
  const fromYear = df.getUTCFullYear();
  const toDay = dt.getUTCDate();
  const toMonth = dt.getUTCMonth() + 1;
  const toYear = dt.getUTCFullYear();
  const toLastDay = lastDayOfMonth(toYear, toMonth);

  // Must start on 1st and end on last day of month for any multi-period
  if (fromDay !== 1 || toDay !== toLastDay) {
    return { type: 'single', periods: [{ dateFrom, dateTo, label: periodLabel(dateFrom, dateTo) }] };
  }

  // Check FY match: from = FY start, to = FY end
  if (fromMonth === fy.fyStartMonth && fromDay === fy.fyStartDay &&
      toMonth === fy.fyEndMonth && toDay === fy.fyEndDay) {
    // Generate 3 FY periods rolling back
    const periods = [];
    for (let i = 0; i < 3; i++) {
      const fyFromYear = fromYear - i;
      let fyToYear;
      // Handle FY that spans calendar years (e.g. Feb 2025 - Jan 2026)
      if (fy.fyEndMonth < fy.fyStartMonth) {
        fyToYear = fyFromYear + 1;
      } else {
        fyToYear = fyFromYear;
      }
      const pFrom = `${fyFromYear}-${String(fy.fyStartMonth).padStart(2,'0')}-${String(fy.fyStartDay).padStart(2,'0')}`;
      const pToDay = lastDayOfMonth(fyToYear, fy.fyEndMonth);
      const pTo = `${fyToYear}-${String(fy.fyEndMonth).padStart(2,'0')}-${String(pToDay).padStart(2,'0')}`;
      periods.push({ dateFrom: pFrom, dateTo: pTo, label: periodLabel(pFrom, pTo) });
    }
    return { type: 'fy', periods };
  }

  // Check quarter match: 3-month span
  let monthSpan;
  if (toMonth >= fromMonth) {
    monthSpan = toMonth - fromMonth + 1;
  } else {
    monthSpan = (12 - fromMonth + 1) + toMonth;
  }

  if (monthSpan === 3 && fromYear === toYear) {
    // Generate 5 quarters rolling back
    const periods = [];
    for (let i = 0; i < 5; i++) {
      let qStartMonth = fromMonth - (i * 3);
      let qStartYear = fromYear;
      while (qStartMonth < 1) { qStartMonth += 12; qStartYear--; }
      let qEndMonth = qStartMonth + 2;
      let qEndYear = qStartYear;
      if (qEndMonth > 12) { qEndMonth -= 12; qEndYear++; }
      const qFromDay = 1;
      const qToDay = lastDayOfMonth(qEndYear, qEndMonth);
      const pFrom = `${qStartYear}-${String(qStartMonth).padStart(2,'0')}-01`;
      const pTo = `${qEndYear}-${String(qEndMonth).padStart(2,'0')}-${String(qToDay).padStart(2,'0')}`;
      periods.push({ dateFrom: pFrom, dateTo: pTo, label: periodLabel(pFrom, pTo) });
    }
    return { type: 'quarter', periods };
  }

  // Check month match: 1-month span
  if (monthSpan === 1 && fromYear === toYear) {
    // Generate 13 months rolling back
    const periods = [];
    for (let i = 0; i < 13; i++) {
      let mMonth = fromMonth - i;
      let mYear = fromYear;
      while (mMonth < 1) { mMonth += 12; mYear--; }
      const mToDay = lastDayOfMonth(mYear, mMonth);
      const pFrom = `${mYear}-${String(mMonth).padStart(2,'0')}-01`;
      const pTo = `${mYear}-${String(mMonth).padStart(2,'0')}-${String(mToDay).padStart(2,'0')}`;
      periods.push({ dateFrom: pFrom, dateTo: pTo, label: periodLabel(pFrom, pTo) });
    }
    return { type: 'month', periods };
  }

  // Default: single period
  return { type: 'single', periods: [{ dateFrom, dateTo, label: periodLabel(dateFrom, dateTo) }] };
}

/**
 * Trial Balance — aggregated debits/credits per account.
 *
 * Input body: { dateFrom?, dateTo?, costCenter?, profitCenter? }
 */
async function refreshTrialBalance(ctx) {
  const { dataset, companyId, body } = ctx;
  const { dateTo, costCenter, profitCenter } = body;

  // TB is always cumulative from inception to dateTo (no dateFrom)
  let whereClause = `je.company_id = @companyId`;
  const params = { companyId };

  if (dateTo) {
    whereClause += ` AND je.date <= @dateTo`;
    params.dateTo = dateTo;
  }
  if (costCenter) {
    whereClause += ` AND je.cost_center = @costCenter`;
    params.costCenter = costCenter;
  }
  if (profitCenter) {
    whereClause += ` AND je.profit_center = @profitCenter`;
    params.profitCenter = profitCenter;
  }

  const [rows] = await dataset.query({
    query: `
      SELECT
        a.account_code,
        a.account_name,
        a.account_type,
        a.account_subtype,
        a.pl_category,
        a.bs_category,
        a.cf_category,
        COALESCE(SUM(je.debit), 0) AS total_debit,
        COALESCE(SUM(je.credit), 0) AS total_credit,
        COALESCE(SUM(je.debit), 0) - COALESCE(SUM(je.credit), 0) AS balance
      FROM finance.accounts a
      LEFT JOIN finance.journal_entries je
        ON a.company_id = je.company_id
        AND a.account_code = je.account_code
        AND ${whereClause.replace('je.company_id = @companyId', 'TRUE')}
      WHERE a.company_id = @companyId AND a.is_active = TRUE
      GROUP BY a.account_code, a.account_name, a.account_type,
               a.account_subtype, a.pl_category, a.bs_category, a.cf_category
      HAVING total_debit != 0 OR total_credit != 0
      ORDER BY a.account_code
    `,
    params,
  });

  return {
    report: 'trial_balance',
    dateFrom: null,
    dateTo: dateTo || null,
    rows: rows.map((r) => ({
      accountCode: r.account_code,
      accountName: r.account_name,
      accountType: r.account_type,
      accountSubtype: r.account_subtype,
      plCategory: r.pl_category,
      bsCategory: r.bs_category,
      cfCategory: r.cf_category,
      debit: Number(r.total_debit),
      credit: Number(r.total_credit),
      balance: Number(r.balance),
    })),
    totalDebit: rows.reduce((s, r) => s + Number(r.total_debit), 0),
    totalCredit: rows.reduce((s, r) => s + Number(r.total_credit), 0),
  };
}

/**
 * Run a single-period P&L query. Returns raw rows.
 */
async function queryPLPeriod(dataset, companyId, dateFrom, dateTo, centerFilter, centerParams) {
  const params = { companyId, ...centerParams };
  let dateFilter = '';
  if (dateFrom) { dateFilter += ` AND je.date >= @dateFrom`; params.dateFrom = dateFrom; }
  if (dateTo) { dateFilter += ` AND je.date <= @dateTo`; params.dateTo = dateTo; }

  const [rows] = await dataset.query({
    query: `
      SELECT
        a.account_code,
        a.account_name,
        a.account_type,
        a.pl_category,
        COALESCE(SUM(je.credit - je.debit), 0) AS amount
      FROM finance.accounts a
      LEFT JOIN finance.journal_entries je
        ON a.company_id = je.company_id
        AND a.account_code = je.account_code
        ${dateFilter}
        ${centerFilter}
      WHERE a.company_id = @companyId
        AND a.account_type IN ('Revenue', 'Expense')
        AND a.is_active = TRUE
      GROUP BY a.account_code, a.account_name, a.account_type, a.pl_category
      HAVING amount != 0
      ORDER BY a.account_code
    `,
    params,
  });
  return rows;
}

/**
 * Profit & Loss — revenue and expense accounts grouped by pl_category.
 * Supports multi-period: detects FY/quarter/month and generates comparative columns.
 */
async function refreshPL(ctx) {
  const { dataset, companyId, body } = ctx;
  const { dateFrom, dateTo, costCenter, profitCenter } = body;

  let centerFilter = '';
  const centerParams = {};
  if (costCenter) { centerFilter += ` AND je.cost_center = @costCenter`; centerParams.costCenter = costCenter; }
  if (profitCenter) { centerFilter += ` AND je.profit_center = @profitCenter`; centerParams.profitCenter = profitCenter; }

  // Detect periods
  const fy = await getCompanyFY(dataset, companyId);
  const detected = detectPeriods(dateFrom, dateTo, fy);

  if (detected.type === 'single') {
    // Original single-period behavior
    const rows = await queryPLPeriod(dataset, companyId, dateFrom, dateTo, centerFilter, centerParams);

    const categories = {};
    let totalRevenue = 0, totalExpenses = 0;
    for (const row of rows) {
      const cat = row.pl_category || 'Uncategorised';
      if (!categories[cat]) categories[cat] = { category: cat, accounts: [], total: 0 };
      const amount = Number(row.amount);
      categories[cat].accounts.push({ accountCode: row.account_code, accountName: row.account_name, accountType: row.account_type, amount });
      categories[cat].total += amount;
      if (row.account_type === 'Revenue') totalRevenue += amount;
      if (row.account_type === 'Expense') totalExpenses += amount;
    }

    return {
      report: 'profit_and_loss',
      dateFrom: dateFrom || null,
      dateTo: dateTo || null,
      categories: Object.values(categories),
      totalRevenue,
      totalExpenses,
      netIncome: totalRevenue + totalExpenses,
    };
  }

  // Multi-period: run queries in parallel
  const periodResults = await Promise.all(
    detected.periods.map((p) => queryPLPeriod(dataset, companyId, p.dateFrom, p.dateTo, centerFilter, centerParams))
  );

  // Build unified account list across all periods
  const accountMap = {}; // key: accountCode
  for (let pi = 0; pi < periodResults.length; pi++) {
    for (const row of periodResults[pi]) {
      const key = row.account_code;
      if (!accountMap[key]) {
        accountMap[key] = {
          accountCode: row.account_code,
          accountName: row.account_name,
          accountType: row.account_type,
          plCategory: row.pl_category || 'Uncategorised',
          amounts: new Array(detected.periods.length).fill(0),
        };
      }
      accountMap[key].amounts[pi] = Number(row.amount);
    }
  }

  // Group by pl_category
  const categories = {};
  const totalRevenue = new Array(detected.periods.length).fill(0);
  const totalExpenses = new Array(detected.periods.length).fill(0);

  for (const acc of Object.values(accountMap)) {
    const cat = acc.plCategory;
    if (!categories[cat]) categories[cat] = { category: cat, accounts: [], totals: new Array(detected.periods.length).fill(0) };
    categories[cat].accounts.push(acc);
    for (let pi = 0; pi < detected.periods.length; pi++) {
      categories[cat].totals[pi] += acc.amounts[pi];
      if (acc.accountType === 'Revenue') totalRevenue[pi] += acc.amounts[pi];
      if (acc.accountType === 'Expense') totalExpenses[pi] += acc.amounts[pi];
    }
  }

  // Sort accounts within each category
  for (const cat of Object.values(categories)) {
    cat.accounts.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  }

  const netIncome = totalRevenue.map((r, i) => r + totalExpenses[i]);

  return {
    report: 'profit_and_loss',
    multiPeriod: true,
    periodType: detected.type,
    periods: detected.periods.map((p) => p.label),
    dateFrom: dateFrom || null,
    dateTo: dateTo || null,
    categories: Object.values(categories),
    totalRevenue,
    totalExpenses,
    netIncome,
  };
}

/**
 * Run a single-period BS query. Returns { rows, totals, sections } for one dateTo.
 * totals are pre-sign-flipped for display (L&E positive = credit-normal).
 */
async function queryBSPeriod(dataset, companyId, dateTo) {
  const params = { companyId };
  let dateFilter = '';
  if (dateTo) { dateFilter = ` AND je.date <= @dateTo`; params.dateTo = dateTo; }

  const [rows] = await dataset.query({
    query: `
      SELECT
        a.account_code,
        a.account_name,
        a.account_type,
        a.bs_category,
        COALESCE(SUM(je.debit - je.credit), 0) AS balance
      FROM finance.accounts a
      LEFT JOIN finance.journal_entries je
        ON a.company_id = je.company_id
        AND a.account_code = je.account_code
        ${dateFilter}
      WHERE a.company_id = @companyId
        AND a.account_type IN ('Asset', 'Liability', 'Equity')
        AND a.is_active = TRUE
      GROUP BY a.account_code, a.account_name, a.account_type, a.bs_category
      HAVING balance != 0
      ORDER BY a.account_code
    `,
    params,
  });

  const sections = { Asset: {}, Liability: {}, Equity: {} };
  const totals = { Asset: 0, Liability: 0, Equity: 0 };

  for (const row of rows) {
    const type = row.account_type;
    const cat = row.bs_category || 'Uncategorised';
    const balance = type === 'Asset' ? Number(row.balance) : -Number(row.balance);
    if (!sections[type][cat]) sections[type][cat] = { category: cat, accounts: {}, total: 0 };
    sections[type][cat].accounts[row.account_code] = {
      accountCode: row.account_code,
      accountName: row.account_name,
      balance,
    };
    sections[type][cat].total += balance;
    totals[type] += balance;
  }

  return { sections, totals };
}

/**
 * Balance Sheet — asset, liability, and equity accounts grouped by bs_category.
 * Supports multi-period: each column shows cumulative balances as at period end.
 */
async function refreshBS(ctx) {
  const { dataset, companyId, body } = ctx;
  const { dateFrom, dateTo } = body;

  // Detect periods using dateFrom + dateTo even though BS only uses dateTo for query
  const fy = await getCompanyFY(dataset, companyId);
  const detected = detectPeriods(dateFrom, dateTo, fy);

  if (detected.type === 'single') {
    // Original single-period behavior
    const { sections, totals } = await queryBSPeriod(dataset, companyId, dateTo);

    // Flatten sections for output
    const flatSections = { Asset: [], Liability: [], Equity: [] };
    for (const type of ['Asset', 'Liability', 'Equity']) {
      for (const cat of Object.values(sections[type])) {
        flatSections[type].push({
          category: cat.category,
          accounts: Object.values(cat.accounts),
          total: cat.total,
        });
      }
    }

    // Balancing net income
    const balancingNetIncome = totals.Asset - totals.Liability - totals.Equity;
    if (Math.abs(balancingNetIncome) > 0.01) {
      const cat = 'Current Year Earnings';
      const existing = flatSections.Equity.find((c) => c.category === cat);
      const entry = { accountCode: '—', accountName: 'Net Income (Current Year)', balance: balancingNetIncome };
      if (existing) { existing.accounts.push(entry); existing.total += balancingNetIncome; }
      else flatSections.Equity.push({ category: cat, accounts: [entry], total: balancingNetIncome });
      totals.Equity += balancingNetIncome;
    }

    return {
      report: 'balance_sheet',
      asAt: dateTo || 'all time',
      assets: flatSections.Asset,
      liabilities: flatSections.Liability,
      equity: flatSections.Equity,
      totalAssets: totals.Asset,
      totalLiabilities: totals.Liability,
      totalEquity: totals.Equity,
      netIncome: balancingNetIncome,
      balanced: Math.abs(totals.Asset - (totals.Liability + totals.Equity)) < 0.01,
    };
  }

  // Multi-period: query each period's dateTo in parallel
  const periodResults = await Promise.all(
    detected.periods.map((p) => queryBSPeriod(dataset, companyId, p.dateTo))
  );

  // Build unified account map across all periods
  // Structure: { type -> category -> accountCode -> { accountCode, accountName, amounts[] } }
  const allAccounts = { Asset: {}, Liability: {}, Equity: {} };
  const periodTotals = { Asset: [], Liability: [], Equity: [] };
  for (const type of ['Asset', 'Liability', 'Equity']) {
    periodTotals[type] = new Array(detected.periods.length).fill(0);
  }

  for (let pi = 0; pi < periodResults.length; pi++) {
    const { sections, totals } = periodResults[pi];
    for (const type of ['Asset', 'Liability', 'Equity']) {
      periodTotals[type][pi] = totals[type];
      for (const cat of Object.values(sections[type])) {
        if (!allAccounts[type][cat.category]) allAccounts[type][cat.category] = {};
        for (const acc of Object.values(cat.accounts)) {
          if (!allAccounts[type][cat.category][acc.accountCode]) {
            allAccounts[type][cat.category][acc.accountCode] = {
              accountCode: acc.accountCode,
              accountName: acc.accountName,
              amounts: new Array(detected.periods.length).fill(0),
            };
          }
          allAccounts[type][cat.category][acc.accountCode].amounts[pi] = acc.balance;
        }
      }
    }
  }

  // Compute balancing net income for each period
  const balancingNetIncome = detected.periods.map((_, pi) =>
    periodTotals.Asset[pi] - periodTotals.Liability[pi] - periodTotals.Equity[pi]
  );

  // Add net income row to Equity
  const hasNetIncome = balancingNetIncome.some((ni) => Math.abs(ni) > 0.01);
  if (hasNetIncome) {
    const cat = 'Current Year Earnings';
    if (!allAccounts.Equity[cat]) allAccounts.Equity[cat] = {};
    allAccounts.Equity[cat]['—'] = {
      accountCode: '—',
      accountName: 'Net Income (Current Year)',
      amounts: balancingNetIncome,
    };
    for (let pi = 0; pi < detected.periods.length; pi++) {
      periodTotals.Equity[pi] += balancingNetIncome[pi];
    }
  }

  // Build output sections
  const buildSection = (type) => {
    const cats = [];
    for (const [catName, accounts] of Object.entries(allAccounts[type])) {
      const accList = Object.values(accounts).sort((a, b) => a.accountCode.localeCompare(b.accountCode));
      const catTotals = new Array(detected.periods.length).fill(0);
      for (const acc of accList) {
        for (let pi = 0; pi < detected.periods.length; pi++) catTotals[pi] += acc.amounts[pi];
      }
      cats.push({ category: catName, accounts: accList, totals: catTotals });
    }
    return cats;
  };

  // Check balance per period
  const balanced = detected.periods.map((_, pi) =>
    Math.abs(periodTotals.Asset[pi] - (periodTotals.Liability[pi] + periodTotals.Equity[pi])) < 0.01
  );

  return {
    report: 'balance_sheet',
    multiPeriod: true,
    periodType: detected.type,
    periods: detected.periods.map((p) => `As at ${p.dateTo}`),
    asAt: dateTo || 'all time',
    assets: buildSection('Asset'),
    liabilities: buildSection('Liability'),
    equity: buildSection('Equity'),
    totalAssets: periodTotals.Asset,
    totalLiabilities: periodTotals.Liability,
    totalEquity: periodTotals.Equity,
    netIncome: balancingNetIncome,
    balanced,
  };
}

/**
 * Cash Flow Statement — journal entries grouped by cf_category.
 *
 * Uses the indirect method: starts from net income, adjusts for working capital,
 * then shows investing and financing activities.
 */
async function refreshCF(ctx) {
  const { dataset, companyId, body } = ctx;
  const { dateFrom, dateTo } = body;

  const params = { companyId };
  let dateFilter = '';

  if (dateFrom) {
    dateFilter += ` AND je.date >= @dateFrom`;
    params.dateFrom = dateFrom;
  }
  if (dateTo) {
    dateFilter += ` AND je.date <= @dateTo`;
    params.dateTo = dateTo;
  }

  // Get net income (P&L accounts)
  const [plRows] = await dataset.query({
    query: `
      SELECT COALESCE(SUM(je.credit - je.debit), 0) AS net_income
      FROM finance.journal_entries je
      JOIN finance.accounts a
        ON je.company_id = a.company_id AND je.account_code = a.account_code
      WHERE je.company_id = @companyId
        AND a.account_type IN ('Revenue', 'Expense')
        ${dateFilter}
    `,
    params,
  });
  const netIncome = Number(plRows[0]?.net_income || 0);

  // Get CF movements by category (for BS accounts)
  const [cfRows] = await dataset.query({
    query: `
      SELECT
        a.cf_category,
        a.account_code,
        a.account_name,
        COALESCE(SUM(je.debit - je.credit), 0) AS movement
      FROM finance.journal_entries je
      JOIN finance.accounts a
        ON je.company_id = a.company_id AND je.account_code = a.account_code
      WHERE je.company_id = @companyId
        AND a.account_type IN ('Asset', 'Liability', 'Equity')
        AND a.cf_category IS NOT NULL
        ${dateFilter}
      GROUP BY a.cf_category, a.account_code, a.account_name
      HAVING movement != 0
      ORDER BY a.cf_category, a.account_code
    `,
    params,
  });

  // Group by cf_category
  const categories = {};
  for (const row of cfRows) {
    const cat = row.cf_category;
    if (!categories[cat]) {
      categories[cat] = { category: cat, items: [], total: 0 };
    }
    const movement = Number(row.movement);
    categories[cat].items.push({
      accountCode: row.account_code,
      accountName: row.account_name,
      movement,
    });
    categories[cat].total += movement;
  }

  // Check for uncategorised accounts
  const [uncategorised] = await dataset.query({
    query: `
      SELECT a.account_code, a.account_name,
        COALESCE(SUM(je.debit - je.credit), 0) AS movement
      FROM finance.journal_entries je
      JOIN finance.accounts a
        ON je.company_id = a.company_id AND je.account_code = a.account_code
      WHERE je.company_id = @companyId
        AND a.account_type IN ('Asset', 'Liability', 'Equity')
        AND a.cf_category IS NULL
        ${dateFilter}
      GROUP BY a.account_code, a.account_name
      HAVING movement != 0
    `,
    params,
  });

  return {
    report: 'cash_flow',
    dateFrom: dateFrom || null,
    dateTo: dateTo || null,
    netIncome,
    categories: Object.values(categories),
    uncategorised: uncategorised.map((r) => ({
      accountCode: r.account_code,
      accountName: r.account_name,
      movement: Number(r.movement),
    })),
    uncategorisedTotal: uncategorised.reduce((s, r) => s + Number(r.movement), 0),
  };
}

/**
 * Dashboard — key financial metrics.
 */
async function refreshDashboard(ctx) {
  const { dataset, companyId, body } = ctx;
  const { dateFrom, dateTo } = body;

  // Run PL and BS in parallel
  const [pl, bs] = await Promise.all([
    refreshPL({ ...ctx, body: { ...body } }),
    refreshBS({ ...ctx, body: { dateTo } }),
  ]);

  // Get entry counts
  const params = { companyId };
  let dateFilter = '';
  if (dateFrom) {
    dateFilter += ` AND date >= @dateFrom`;
    params.dateFrom = dateFrom;
  }
  if (dateTo) {
    dateFilter += ` AND date <= @dateTo`;
    params.dateTo = dateTo;
  }

  const [counts] = await dataset.query({
    query: `
      SELECT
        COUNT(DISTINCT batch_id) AS entry_count,
        MIN(date) AS first_date,
        MAX(date) AS last_date
      FROM finance.journal_entries
      WHERE company_id = @companyId ${dateFilter}
    `,
    params,
  });

  return {
    report: 'dashboard',
    revenue: pl.totalRevenue,
    expenses: pl.totalExpenses,
    netIncome: pl.netIncome,
    totalAssets: bs.totalAssets,
    totalLiabilities: bs.totalLiabilities,
    totalEquity: bs.totalEquity,
    balanced: bs.balanced,
    entryCount: Number(counts[0]?.entry_count || 0),
    firstDate: counts[0]?.first_date || null,
    lastDate: counts[0]?.last_date || null,
  };
}

/**
 * AP Aging — open bills grouped by aging bucket.
 */
async function refreshAPAging(ctx) {
  const { dataset, companyId } = ctx;

  const [rows] = await dataset.query({
    query: `
      SELECT
        bill_id,
        vendor,
        vendor_ref,
        date,
        due_date,
        amount_home,
        amount_paid,
        (amount_home - amount_paid) AS outstanding,
        DATE_DIFF(CURRENT_DATE(), due_date, DAY) AS days_past_due
      FROM finance.bills
      WHERE company_id = @companyId
        AND status IN ('posted', 'partial')
      ORDER BY due_date
    `,
    params: { companyId },
  });

  // Bucket
  const buckets = {
    current: { label: 'Current', total: 0, bills: [] },
    '1_30': { label: '1-30 days', total: 0, bills: [] },
    '31_60': { label: '31-60 days', total: 0, bills: [] },
    '61_90': { label: '61-90 days', total: 0, bills: [] },
    '90_plus': { label: '90+ days', total: 0, bills: [] },
  };

  for (const row of rows) {
    const outstanding = Number(row.outstanding);
    const days = Number(row.days_past_due);
    const bill = {
      billId: row.bill_id,
      vendor: row.vendor,
      vendorRef: row.vendor_ref,
      date: row.date,
      dueDate: row.due_date,
      outstanding,
      daysPastDue: days,
    };

    let bucket;
    if (days <= 0) bucket = 'current';
    else if (days <= 30) bucket = '1_30';
    else if (days <= 60) bucket = '31_60';
    else if (days <= 90) bucket = '61_90';
    else bucket = '90_plus';

    buckets[bucket].bills.push(bill);
    buckets[bucket].total += outstanding;
  }

  return {
    report: 'ap_aging',
    asAt: new Date().toISOString().substring(0, 10),
    buckets: Object.values(buckets),
    totalOutstanding: Object.values(buckets).reduce((s, b) => s + b.total, 0),
  };
}

/**
 * Statement of Changes in Equity (SCE).
 * Shows opening balance, net income, dividends, share capital changes,
 * other equity movements, and closing balance for the period.
 */
async function refreshSCE(ctx) {
  const { dataset, companyId, body } = ctx;
  const { dateFrom, dateTo } = body;

  if (!dateFrom || !dateTo) {
    throw Object.assign(new Error('SCE requires both dateFrom and dateTo'), { code: 'INVALID_INPUT' });
  }

  // Opening balance: equity account balances before dateFrom
  const [openingRows] = await dataset.query({
    query: `
      SELECT
        a.account_code,
        a.account_name,
        a.account_subtype,
        a.bs_category,
        COALESCE(SUM(je.credit - je.debit), 0) AS balance
      FROM finance.accounts a
      LEFT JOIN finance.journal_entries je
        ON a.company_id = je.company_id
        AND a.account_code = je.account_code
        AND je.date < @dateFrom
      WHERE a.company_id = @companyId
        AND a.account_type = 'Equity'
        AND a.is_active = TRUE
      GROUP BY a.account_code, a.account_name, a.account_subtype, a.bs_category
      ORDER BY a.account_code
    `,
    params: { companyId, dateFrom },
  });

  // Movements during the period for equity accounts
  const [movementRows] = await dataset.query({
    query: `
      SELECT
        a.account_code,
        a.account_name,
        a.account_subtype,
        a.bs_category,
        COALESCE(SUM(je.credit - je.debit), 0) AS movement
      FROM finance.accounts a
      LEFT JOIN finance.journal_entries je
        ON a.company_id = je.company_id
        AND a.account_code = je.account_code
        AND je.date >= @dateFrom AND je.date <= @dateTo
      WHERE a.company_id = @companyId
        AND a.account_type = 'Equity'
        AND a.is_active = TRUE
      GROUP BY a.account_code, a.account_name, a.account_subtype, a.bs_category
      HAVING movement != 0
      ORDER BY a.account_code
    `,
    params: { companyId, dateFrom, dateTo },
  });

  // Net income for the period (P&L accounts)
  const [plRows] = await dataset.query({
    query: `
      SELECT COALESCE(SUM(je.credit - je.debit), 0) AS net_income
      FROM finance.journal_entries je
      JOIN finance.accounts a
        ON je.company_id = a.company_id AND je.account_code = a.account_code
      WHERE je.company_id = @companyId
        AND a.account_type IN ('Revenue', 'Expense')
        AND je.date >= @dateFrom AND je.date <= @dateTo
    `,
    params: { companyId, dateFrom, dateTo },
  });
  const netIncome = Number(plRows[0]?.net_income || 0);

  // Build equity components
  const equityAccounts = {};
  for (const row of openingRows) {
    equityAccounts[row.account_code] = {
      accountCode: row.account_code,
      accountName: row.account_name,
      subtype: row.account_subtype || row.bs_category || 'Other',
      opening: Number(row.balance),
      movement: 0,
      closing: Number(row.balance),
    };
  }

  for (const row of movementRows) {
    if (!equityAccounts[row.account_code]) {
      equityAccounts[row.account_code] = {
        accountCode: row.account_code,
        accountName: row.account_name,
        subtype: row.account_subtype || row.bs_category || 'Other',
        opening: 0,
        movement: 0,
        closing: 0,
      };
    }
    equityAccounts[row.account_code].movement = Number(row.movement);
    equityAccounts[row.account_code].closing = equityAccounts[row.account_code].opening + Number(row.movement);
  }

  // Classify movements
  const components = [];
  let totalOpening = 0, totalMovement = 0, totalClosing = 0;

  for (const acc of Object.values(equityAccounts)) {
    if (Math.abs(acc.opening) < 0.01 && Math.abs(acc.movement) < 0.01) continue;
    components.push(acc);
    totalOpening += acc.opening;
    totalMovement += acc.movement;
    totalClosing += acc.closing;
  }

  return {
    report: 'statement_of_changes_in_equity',
    dateFrom,
    dateTo,
    components,
    netIncome,
    totalOpening,
    totalMovement,
    totalClosing: totalClosing + netIncome,
    rows: [
      { label: 'Opening Equity', amount: totalOpening },
      ...components.filter((c) => Math.abs(c.movement) >= 0.01).map((c) => ({
        label: `${c.accountName} (movement)`,
        amount: c.movement,
      })),
      { label: 'Net Income for Period', amount: netIncome },
      { label: 'Closing Equity', amount: totalClosing + netIncome },
    ],
  };
}

/**
 * Integrity Check — validates journal data consistency.
 * Checks: batch balance, orphan accounts, locked period violations, FX home balance.
 */
async function refreshIntegrity(ctx) {
  const { dataset, companyId } = ctx;

  // 1. Summary counts
  const [summary] = await dataset.query({
    query: `
      SELECT
        COUNT(*) AS total_entries,
        COUNT(DISTINCT batch_id) AS total_batches,
        MIN(date) AS first_date,
        MAX(date) AS last_date
      FROM finance.journal_entries
      WHERE company_id = @companyId
    `,
    params: { companyId },
  });
  const totalEntries = Number(summary[0]?.total_entries || 0);
  const totalBatches = Number(summary[0]?.total_batches || 0);

  // 2. Unbalanced batches (debit_home ≠ credit_home per batch)
  const [unbalancedBatches] = await dataset.query({
    query: `
      SELECT
        batch_id,
        SUM(debit_home) AS total_debit,
        SUM(credit_home) AS total_credit,
        ABS(SUM(debit_home) - SUM(credit_home)) AS variance,
        MIN(date) AS date,
        COUNT(*) AS line_count
      FROM finance.journal_entries
      WHERE company_id = @companyId
      GROUP BY batch_id
      HAVING ABS(SUM(debit_home) - SUM(credit_home)) > 0.01
      ORDER BY variance DESC
      LIMIT 50
    `,
    params: { companyId },
  });

  // 3. Orphan account codes (in journal_entries but not in accounts)
  const [orphanAccounts] = await dataset.query({
    query: `
      SELECT DISTINCT je.account_code, COUNT(*) AS entry_count
      FROM finance.journal_entries je
      LEFT JOIN finance.accounts a
        ON je.company_id = a.company_id AND je.account_code = a.account_code
      WHERE je.company_id = @companyId
        AND a.account_code IS NULL
      GROUP BY je.account_code
      ORDER BY je.account_code
    `,
    params: { companyId },
  });

  // 4. Entries in locked periods
  // Check if there's a lock_date setting
  const [lockRows] = await dataset.query({
    query: `
      SELECT value FROM finance.settings
      WHERE company_id = @companyId AND key = 'lock_date'
    `,
    params: { companyId },
  });
  const lockDate = lockRows.length > 0 ? lockRows[0].value : null;
  let lockedPeriodEntries = [];
  if (lockDate) {
    const [locked] = await dataset.query({
      query: `
        SELECT batch_id, date, account_code, description,
               debit_home, credit_home
        FROM finance.journal_entries
        WHERE company_id = @companyId AND date <= @lockDate
          AND created_at > (
            SELECT COALESCE(MAX(created_at), TIMESTAMP('1970-01-01'))
            FROM finance.journal_entries
            WHERE company_id = @companyId AND date <= @lockDate
              AND source = 'lock'
          )
        ORDER BY date
        LIMIT 50
      `,
      params: { companyId, lockDate },
    });
    lockedPeriodEntries = locked;
  }

  // 5. FX home currency imbalance per batch (different from #2, this flags
  //    batches that have foreign currency lines where home amounts don't net)
  const [fxImbalance] = await dataset.query({
    query: `
      SELECT
        batch_id,
        SUM(debit_home) AS total_debit_home,
        SUM(credit_home) AS total_credit_home,
        ABS(SUM(debit_home) - SUM(credit_home)) AS home_variance,
        MIN(date) AS date
      FROM finance.journal_entries
      WHERE company_id = @companyId
        AND currency IS NOT NULL AND currency != ''
      GROUP BY batch_id
      HAVING ABS(SUM(debit_home) - SUM(credit_home)) > 0.01
      ORDER BY home_variance DESC
      LIMIT 50
    `,
    params: { companyId },
  });

  // Compute pass/fail
  const checks = [
    {
      check: 'Batch Balance',
      description: 'Every batch_id should have equal debits and credits',
      passed: unbalancedBatches.length === 0,
      failCount: unbalancedBatches.length,
      details: unbalancedBatches.map((b) => ({
        batchId: b.batch_id,
        date: b.date,
        totalDebit: Number(b.total_debit),
        totalCredit: Number(b.total_credit),
        variance: Number(b.variance),
        lineCount: Number(b.line_count),
      })),
    },
    {
      check: 'Orphan Accounts',
      description: 'All account_codes in journal_entries should exist in accounts table',
      passed: orphanAccounts.length === 0,
      failCount: orphanAccounts.length,
      details: orphanAccounts.map((a) => ({
        accountCode: a.account_code,
        entryCount: Number(a.entry_count),
      })),
    },
    {
      check: 'Locked Period',
      description: lockDate ? `No new entries on or before lock date ${lockDate}` : 'No lock date configured',
      passed: lockedPeriodEntries.length === 0,
      failCount: lockedPeriodEntries.length,
      details: lockedPeriodEntries.slice(0, 20).map((e) => ({
        batchId: e.batch_id,
        date: e.date,
        accountCode: e.account_code,
      })),
    },
    {
      check: 'FX Home Balance',
      description: 'Multi-currency batches should balance in home currency',
      passed: fxImbalance.length === 0,
      failCount: fxImbalance.length,
      details: fxImbalance.map((b) => ({
        batchId: b.batch_id,
        date: b.date,
        homeVariance: Number(b.home_variance),
      })),
    },
  ];

  const passCount = checks.filter((c) => c.passed).length;
  const failCount = checks.filter((c) => !c.passed).length;

  return {
    report: 'integrity_check',
    totalEntries,
    totalBatches,
    firstDate: summary[0]?.first_date || null,
    lastDate: summary[0]?.last_date || null,
    lockDate: lockDate || null,
    checks,
    summary: { total: checks.length, passed: passCount, failed: failCount },
    overallPass: failCount === 0,
  };
}

module.exports = { handleReports };
