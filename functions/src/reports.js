/**
 * Skuld — Report generation
 *
 * Generates: Trial Balance, P&L, Balance Sheet, Cash Flow, Dashboard, AP Aging, VAT Return
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
    default:
      throw Object.assign(new Error(`Unknown report action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

/**
 * Trial Balance — aggregated debits/credits per account.
 *
 * Input body: { dateFrom?, dateTo?, costCenter?, profitCenter? }
 */
async function refreshTrialBalance(ctx) {
  const { dataset, companyId, body } = ctx;
  const { dateFrom, dateTo, costCenter, profitCenter } = body;

  let whereClause = `je.company_id = @companyId`;
  const params = { companyId };

  if (dateFrom) {
    whereClause += ` AND je.date >= @dateFrom`;
    params.dateFrom = dateFrom;
  }
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
        COALESCE(SUM(je.debit_home), 0) AS total_debit,
        COALESCE(SUM(je.credit_home), 0) AS total_credit,
        COALESCE(SUM(je.debit_home), 0) - COALESCE(SUM(je.credit_home), 0) AS balance
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
    dateFrom: dateFrom || null,
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
 * Profit & Loss — revenue and expense accounts grouped by pl_category.
 */
async function refreshPL(ctx) {
  const { dataset, companyId, body } = ctx;
  const { dateFrom, dateTo, costCenter, profitCenter } = body;

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

  let centerFilter = '';
  if (costCenter) {
    centerFilter += ` AND je.cost_center = @costCenter`;
    params.costCenter = costCenter;
  }
  if (profitCenter) {
    centerFilter += ` AND je.profit_center = @profitCenter`;
    params.profitCenter = profitCenter;
  }

  const [rows] = await dataset.query({
    query: `
      SELECT
        a.account_code,
        a.account_name,
        a.account_type,
        a.pl_category,
        COALESCE(SUM(je.credit_home - je.debit_home), 0) AS amount
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

  // Group by pl_category
  const categories = {};
  let totalRevenue = 0;
  let totalExpenses = 0;

  for (const row of rows) {
    const cat = row.pl_category || 'Uncategorised';
    if (!categories[cat]) {
      categories[cat] = { category: cat, accounts: [], total: 0 };
    }
    const amount = Number(row.amount);
    categories[cat].accounts.push({
      accountCode: row.account_code,
      accountName: row.account_name,
      accountType: row.account_type,
      amount,
    });
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
    netIncome: totalRevenue + totalExpenses, // expenses are negative
  };
}

/**
 * Balance Sheet — asset, liability, and equity accounts grouped by bs_category.
 */
async function refreshBS(ctx) {
  const { dataset, companyId, body } = ctx;
  const { dateTo } = body;

  const params = { companyId };
  let dateFilter = '';

  if (dateTo) {
    dateFilter = ` AND je.date <= @dateTo`;
    params.dateTo = dateTo;
  }

  const [rows] = await dataset.query({
    query: `
      SELECT
        a.account_code,
        a.account_name,
        a.account_type,
        a.bs_category,
        COALESCE(SUM(je.debit_home - je.credit_home), 0) AS balance
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

  // Group by account_type then bs_category
  const sections = { Asset: {}, Liability: {}, Equity: {} };
  const totals = { Asset: 0, Liability: 0, Equity: 0 };

  for (const row of rows) {
    const type = row.account_type;
    const cat = row.bs_category || 'Uncategorised';
    // Liabilities and Equity are credit-normal → flip sign for display
    const balance = type === 'Asset' ? Number(row.balance) : -Number(row.balance);

    if (!sections[type][cat]) {
      sections[type][cat] = { category: cat, accounts: [], total: 0 };
    }
    sections[type][cat].accounts.push({
      accountCode: row.account_code,
      accountName: row.account_name,
      balance,
    });
    sections[type][cat].total += balance;
    totals[type] += balance;
  }

  // Calculate current year net income (P&L accounts) for the balanced check
  const plParams = { companyId };
  let plDateFilter = '';
  if (dateTo) {
    plDateFilter = ` AND je.date <= @dateTo`;
    plParams.dateTo = dateTo;
  }

  const [plRows] = await dataset.query({
    query: `
      SELECT COALESCE(SUM(je.credit_home - je.debit_home), 0) AS net_income
      FROM finance.journal_entries je
      JOIN finance.accounts a
        ON je.company_id = a.company_id AND je.account_code = a.account_code
      WHERE je.company_id = @companyId
        AND a.account_type IN ('Revenue', 'Expense')
        ${plDateFilter}
    `,
    params: plParams,
  });
  const netIncome = Number(plRows[0]?.net_income || 0);

  // Add net income as a virtual equity line
  if (Math.abs(netIncome) > 0.01) {
    const cat = 'Current Year Earnings';
    if (!sections.Equity[cat]) {
      sections.Equity[cat] = { category: cat, accounts: [], total: 0 };
    }
    sections.Equity[cat].accounts.push({
      accountCode: '—',
      accountName: 'Net Income (Current Year)',
      balance: netIncome,
    });
    sections.Equity[cat].total += netIncome;
    totals.Equity += netIncome;
  }

  return {
    report: 'balance_sheet',
    asAt: dateTo || 'all time',
    assets: Object.values(sections.Asset),
    liabilities: Object.values(sections.Liability),
    equity: Object.values(sections.Equity),
    totalAssets: totals.Asset,
    totalLiabilities: totals.Liability,
    totalEquity: totals.Equity,
    netIncome,
    balanced: Math.abs(totals.Asset - (totals.Liability + totals.Equity)) < 0.01,
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
      SELECT COALESCE(SUM(je.credit_home - je.debit_home), 0) AS net_income
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
        COALESCE(SUM(je.debit_home - je.credit_home), 0) AS movement
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
        COALESCE(SUM(je.debit_home - je.credit_home), 0) AS movement
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

module.exports = { handleReports };
