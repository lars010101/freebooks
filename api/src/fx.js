'use strict';
/**
 * freeBooks — FX rate service
 * Ported from BigQuery Cloud Function to DuckDB/Express.
 */

const { v4: uuid } = require('uuid');
const { query, exec, bulkInsert } = require('./db');

async function handleFx(ctx, action) {
  switch (action) {
    case 'fx.fetch_rates':          return fetchRates(ctx);
    case 'fx.revaluation_preview':  return revaluationPreview(ctx);
    case 'fx.revaluation_post':     return revaluationPost(ctx);
    default:
      throw Object.assign(new Error(`Unknown FX action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

async function fetchRates(ctx) {
  const { companyId, body } = ctx;

  const companies = await query(
    `SELECT currency FROM companies WHERE company_id = @companyId LIMIT 1`,
    { companyId }
  );
  if (companies.length === 0) throw Object.assign(new Error('Company not found'), { code: 'NOT_FOUND' });

  const baseCurrency = body.baseCurrency || companies[0].currency;
  const date = body.date || 'latest';

  const url = date === 'latest'
    ? `https://api.frankfurter.app/latest?from=${baseCurrency}`
    : `https://api.frankfurter.app/${date}?from=${baseCurrency}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw Object.assign(new Error(`FX rate fetch failed: ${response.status}`), { code: 'FX_FETCH_ERROR' });
  }

  const data = await response.json();
  const rateDate = data.date;
  const rates = data.rates;
  const now = new Date().toISOString();

  // Delete existing rates for this date + base (DuckDB UPDATE/DELETE works immediately)
  await exec(
    `DELETE FROM fx_rates WHERE date = @rateDate AND source = 'ecb'
     AND (from_currency = @baseCurrency OR to_currency = @baseCurrency)`,
    { rateDate, baseCurrency }
  );

  const rows = [
    ...Object.entries(rates).map(([currency, rate]) => ({
      date: rateDate, from_currency: baseCurrency, to_currency: currency, rate, source: 'ecb', fetched_at: now,
    })),
    ...Object.entries(rates).map(([currency, rate]) => ({
      date: rateDate, from_currency: currency, to_currency: baseCurrency, rate: Math.round((1 / rate) * 1000000) / 1000000, source: 'ecb', fetched_at: now,
    })),
  ];

  if (rows.length > 0) await bulkInsert('fx_rates', rows);

  return { date: rateDate, baseCurrency, rateCount: Object.keys(rates).length, currencies: Object.keys(rates) };
}

async function getRate(fromCurrency, toCurrency, date) {
  if (fromCurrency === toCurrency) return 1.0;

  const exact = await query(
    `SELECT rate FROM fx_rates WHERE from_currency = @from AND to_currency = @to AND date = @date ORDER BY source = 'manual' DESC, fetched_at DESC LIMIT 1`,
    { from: fromCurrency, to: toCurrency, date }
  );
  if (exact.length > 0) return Number(exact[0].rate);

  const nearest = await query(
    `SELECT rate FROM fx_rates WHERE from_currency = @from AND to_currency = @to AND date <= @date ORDER BY date DESC LIMIT 1`,
    { from: fromCurrency, to: toCurrency, date }
  );
  if (nearest.length > 0) return Number(nearest[0].rate);

  return null;
}

async function revaluationPreview(ctx) {
  const { companyId, body } = ctx;
  const { revalDate } = body;
  if (!revalDate) throw Object.assign(new Error('revalDate required'), { code: 'INVALID_INPUT' });

  const companies = await query(`SELECT currency FROM companies WHERE company_id = @companyId LIMIT 1`, { companyId });
  const homeCurrency = companies[0].currency;

  const balances = await query(
    `SELECT je.account_code, a.account_name, je.currency,
            SUM(je.debit - je.credit) AS foreign_balance,
            SUM(je.debit_home - je.credit_home) AS home_balance
     FROM journal_entries je
     JOIN accounts a ON je.company_id = a.company_id AND je.account_code = a.account_code
     WHERE je.company_id = @companyId
       AND je.date <= @revalDate
       AND je.currency != @homeCurrency
       AND a.account_type IN ('Asset', 'Liability', 'Equity')
     GROUP BY je.account_code, a.account_name, je.currency
     HAVING SUM(je.debit - je.credit) != 0`,
    { companyId, revalDate, homeCurrency }
  );

  const adjustments = [];
  for (const bal of balances) {
    const closingRate = await getRate(bal.currency, homeCurrency, revalDate);
    if (closingRate === null) {
      adjustments.push({ accountCode: bal.account_code, accountName: bal.account_name, currency: bal.currency, foreignBalance: Number(bal.foreign_balance), error: `No closing rate for ${bal.currency}→${homeCurrency} on ${revalDate}` });
      continue;
    }
    const revaluedHome = Number(bal.foreign_balance) * closingRate;
    const currentHome = Number(bal.home_balance);
    const fxGainLoss = revaluedHome - currentHome;
    if (Math.abs(fxGainLoss) > 0.01) {
      adjustments.push({ accountCode: bal.account_code, accountName: bal.account_name, currency: bal.currency, foreignBalance: Number(bal.foreign_balance), closingRate, currentHomeBalance: currentHome, revaluedHomeBalance: revaluedHome, fxGainLoss });
    }
  }

  return { revalDate, homeCurrency, adjustments, totalGainLoss: adjustments.reduce((s, a) => s + (a.fxGainLoss || 0), 0) };
}

async function revaluationPost(ctx) {
  const { companyId, userEmail, body } = ctx;
  const { revalDate, fxGainLossAccount, adjustments } = body;
  if (!revalDate || !fxGainLossAccount || !adjustments) {
    throw Object.assign(new Error('revalDate, fxGainLossAccount, and adjustments required'), { code: 'INVALID_INPUT' });
  }

  const companies = await query(`SELECT currency FROM companies WHERE company_id = @companyId LIMIT 1`, { companyId });
  const homeCurrency = companies[0].currency;

  const batchId = uuid();
  const now = new Date().toISOString();
  const lines = [];

  for (const adj of adjustments) {
    if (!adj.fxGainLoss || Math.abs(adj.fxGainLoss) < 0.01) continue;
    const isGain = adj.fxGainLoss > 0;
    const amount = Math.abs(adj.fxGainLoss);

    const base = { company_id: companyId, batch_id: batchId, date: revalDate, currency: homeCurrency, fx_rate: 1.0, vat_code: null, vat_amount: 0, vat_amount_home: 0, net_amount: 0, net_amount_home: 0, source: 'fx_revaluation', cost_center: null, profit_center: null, reverses: null, reversed_by: null, bill_id: null, created_by: userEmail, created_at: now };

    lines.push({ ...base, entry_id: uuid(), account_code: adj.accountCode, debit: isGain ? amount : 0, credit: isGain ? 0 : amount, debit_home: isGain ? amount : 0, credit_home: isGain ? 0 : amount, description: `FX revaluation: ${adj.accountCode} ${adj.currency}`, reference: `FXREVAL-${revalDate}` });
    lines.push({ ...base, entry_id: uuid(), account_code: fxGainLossAccount, debit: isGain ? 0 : amount, credit: isGain ? amount : 0, debit_home: isGain ? 0 : amount, credit_home: isGain ? amount : 0, description: `FX ${isGain ? 'gain' : 'loss'}: ${adj.accountCode} ${adj.currency}`, reference: `FXREVAL-${revalDate}` });
  }

  if (lines.length > 0) await bulkInsert('journal_entries', lines);

  return { posted: true, batchId, lineCount: lines.length, totalGainLoss: adjustments.reduce((s, a) => s + (a.fxGainLoss || 0), 0) };
}

module.exports = { handleFx, getRate };
