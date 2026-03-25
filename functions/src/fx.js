/**
 * Skuld — FX rate service
 *
 * Fetches rates from ECB via Frankfurter API (free, no key).
 * Handles FX revaluation at year-end.
 */

const { v4: uuid } = require('uuid');

/**
 * Route FX actions.
 */
async function handleFx(ctx, action) {
  switch (action) {
    case 'fx.fetch_rates':
      return fetchRates(ctx);
    case 'fx.revaluation_preview':
      return revaluationPreview(ctx);
    case 'fx.revaluation_post':
      return revaluationPost(ctx);
    default:
      throw Object.assign(new Error(`Unknown FX action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

/**
 * Fetch current FX rates from ECB/Frankfurter and store in BigQuery.
 *
 * Input body: { baseCurrency?, date? }
 */
async function fetchRates(ctx) {
  const { dataset, companyId, body } = ctx;

  // Get company's home currency
  const [companies] = await dataset.query({
    query: `SELECT currency FROM finance.companies WHERE company_id = @companyId`,
    params: { companyId },
  });
  if (companies.length === 0) {
    throw Object.assign(new Error('Company not found'), { code: 'NOT_FOUND' });
  }

  const baseCurrency = body.baseCurrency || companies[0].currency;
  const date = body.date || 'latest';

  // Fetch from Frankfurter API
  const url = date === 'latest'
    ? `https://api.frankfurter.app/latest?from=${baseCurrency}`
    : `https://api.frankfurter.app/${date}?from=${baseCurrency}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw Object.assign(
      new Error(`FX rate fetch failed: ${response.status} ${response.statusText}`),
      { code: 'FX_FETCH_ERROR' }
    );
  }

  const data = await response.json();
  const rateDate = data.date;
  const rates = data.rates;
  const now = new Date().toISOString();

  // Store rates
  const rows = Object.entries(rates).map(([currency, rate]) => ({
    date: rateDate,
    from_currency: baseCurrency,
    to_currency: currency,
    rate,
    source: 'ecb',
    fetched_at: now,
  }));

  // Also add the inverse rate (to → from)
  const inverseRows = Object.entries(rates).map(([currency, rate]) => ({
    date: rateDate,
    from_currency: currency,
    to_currency: baseCurrency,
    rate: Math.round((1 / rate) * 1000000) / 1000000,
    source: 'ecb',
    fetched_at: now,
  }));

  // Delete existing rates for this date + base to avoid duplicates
  await dataset.query({
    query: `DELETE FROM finance.fx_rates WHERE date = @rateDate AND source = 'ecb'
            AND (from_currency = @baseCurrency OR to_currency = @baseCurrency)`,
    params: { rateDate, baseCurrency },
  });

  const allRows = [...rows, ...inverseRows];
  if (allRows.length > 0) {
    await dataset.table('fx_rates').insert(allRows);
  }

  return {
    date: rateDate,
    baseCurrency,
    rateCount: rows.length,
    currencies: Object.keys(rates),
  };
}

/**
 * Look up an FX rate for a specific date and currency pair.
 * Falls back to nearest available date if exact date not found.
 */
async function getRate(dataset, fromCurrency, toCurrency, date) {
  if (fromCurrency === toCurrency) return 1.0;

  // Try exact date first
  const [exact] = await dataset.query({
    query: `SELECT rate FROM finance.fx_rates
            WHERE from_currency = @from AND to_currency = @to AND date = @date
            ORDER BY source = 'manual' DESC, fetched_at DESC
            LIMIT 1`,
    params: { from: fromCurrency, to: toCurrency, date },
  });

  if (exact.length > 0) return Number(exact[0].rate);

  // Fall back to nearest earlier date
  const [nearest] = await dataset.query({
    query: `SELECT rate FROM finance.fx_rates
            WHERE from_currency = @from AND to_currency = @to AND date <= @date
            ORDER BY date DESC
            LIMIT 1`,
    params: { from: fromCurrency, to: toCurrency, date },
  });

  if (nearest.length > 0) return Number(nearest[0].rate);

  return null; // No rate found
}

/**
 * Preview FX revaluation — show what entries would be created.
 *
 * Identifies balance sheet accounts with foreign currency balances,
 * computes unrealised gains/losses at the closing rate.
 */
async function revaluationPreview(ctx) {
  const { dataset, companyId, body } = ctx;
  const { revalDate } = body;

  if (!revalDate) {
    throw Object.assign(new Error('revalDate required'), { code: 'INVALID_INPUT' });
  }

  // Get company
  const [companies] = await dataset.query({
    query: `SELECT currency FROM finance.companies WHERE company_id = @companyId`,
    params: { companyId },
  });
  const homeCurrency = companies[0].currency;

  // Get foreign currency balances on BS accounts
  const [balances] = await dataset.query({
    query: `
      SELECT
        je.account_code,
        a.account_name,
        je.currency,
        SUM(je.debit - je.credit) AS foreign_balance,
        SUM(je.debit_home - je.credit_home) AS home_balance
      FROM finance.journal_entries je
      JOIN finance.accounts a
        ON je.company_id = a.company_id AND je.account_code = a.account_code
      WHERE je.company_id = @companyId
        AND je.date <= @revalDate
        AND je.currency != @homeCurrency
        AND a.account_type IN ('Asset', 'Liability', 'Equity')
      GROUP BY je.account_code, a.account_name, je.currency
      HAVING foreign_balance != 0
    `,
    params: { companyId, revalDate, homeCurrency },
  });

  // Compute revaluation for each
  const adjustments = [];
  for (const bal of balances) {
    const closingRate = await getRate(dataset, bal.currency, homeCurrency, revalDate);
    if (closingRate === null) {
      adjustments.push({
        accountCode: bal.account_code,
        accountName: bal.account_name,
        currency: bal.currency,
        foreignBalance: Number(bal.foreign_balance),
        error: `No closing rate found for ${bal.currency}→${homeCurrency} on ${revalDate}`,
      });
      continue;
    }

    const revaluedHome = Number(bal.foreign_balance) * closingRate;
    const currentHome = Number(bal.home_balance);
    const fxGainLoss = revaluedHome - currentHome;

    if (Math.abs(fxGainLoss) > 0.01) {
      adjustments.push({
        accountCode: bal.account_code,
        accountName: bal.account_name,
        currency: bal.currency,
        foreignBalance: Number(bal.foreign_balance),
        closingRate,
        currentHomeBalance: currentHome,
        revaluedHomeBalance: revaluedHome,
        fxGainLoss,
      });
    }
  }

  return {
    revalDate,
    homeCurrency,
    adjustments,
    totalGainLoss: adjustments.reduce((s, a) => s + (a.fxGainLoss || 0), 0),
  };
}

/**
 * Post FX revaluation entries.
 *
 * Input body: { revalDate, fxGainLossAccount, adjustments (from preview) }
 */
async function revaluationPost(ctx) {
  const { dataset, companyId, userEmail, body } = ctx;
  const { revalDate, fxGainLossAccount, adjustments } = body;

  if (!revalDate || !fxGainLossAccount || !adjustments) {
    throw Object.assign(new Error('revalDate, fxGainLossAccount, and adjustments required'), { code: 'INVALID_INPUT' });
  }

  const batchId = uuid();
  const now = new Date().toISOString();
  const lines = [];

  // Get home currency
  const [companies] = await dataset.query({
    query: `SELECT currency FROM finance.companies WHERE company_id = @companyId`,
    params: { companyId },
  });
  const homeCurrency = companies[0].currency;

  for (const adj of adjustments) {
    if (!adj.fxGainLoss || Math.abs(adj.fxGainLoss) < 0.01) continue;

    const isGain = adj.fxGainLoss > 0;
    const amount = Math.abs(adj.fxGainLoss);

    // Adjust the BS account
    lines.push({
      company_id: companyId,
      entry_id: uuid(),
      batch_id: batchId,
      date: revalDate,
      account_code: adj.accountCode,
      debit: isGain ? amount : 0,
      credit: isGain ? 0 : amount,
      currency: homeCurrency,
      fx_rate: 1.0,
      debit_home: isGain ? amount : 0,
      credit_home: isGain ? 0 : amount,
      vat_code: null,
      vat_amount: 0,
      vat_amount_home: 0,
      net_amount: 0,
      net_amount_home: 0,
      description: `FX revaluation: ${adj.accountCode} ${adj.currency}`,
      reference: `FXREVAL-${revalDate}`,
      source: 'fx_revaluation',
      cost_center: null,
      profit_center: null,
      reverses: null,
      reversed_by: null,
      bill_id: null,
      created_by: userEmail,
      created_at: now,
    });

    // Offset to FX gain/loss P&L account
    lines.push({
      company_id: companyId,
      entry_id: uuid(),
      batch_id: batchId,
      date: revalDate,
      account_code: fxGainLossAccount,
      debit: isGain ? 0 : amount,
      credit: isGain ? amount : 0,
      currency: homeCurrency,
      fx_rate: 1.0,
      debit_home: isGain ? 0 : amount,
      credit_home: isGain ? amount : 0,
      vat_code: null,
      vat_amount: 0,
      vat_amount_home: 0,
      net_amount: 0,
      net_amount_home: 0,
      description: `FX ${isGain ? 'gain' : 'loss'}: ${adj.accountCode} ${adj.currency}`,
      reference: `FXREVAL-${revalDate}`,
      source: 'fx_revaluation',
      cost_center: null,
      profit_center: null,
      reverses: null,
      reversed_by: null,
      bill_id: null,
      created_by: userEmail,
      created_at: now,
    });
  }

  if (lines.length > 0) {
    await dataset.table('journal_entries').insert(lines);
  }

  return {
    posted: true,
    batchId,
    lineCount: lines.length,
    totalGainLoss: adjustments.reduce((s, a) => s + (a.fxGainLoss || 0), 0),
  };
}

module.exports = { handleFx, getRate };
