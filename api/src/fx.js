'use strict';
/**
 * freeBooks — FX rate service
 * Ported from BigQuery Cloud Function to DuckDB/Express.
 */

const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const { query, exec, bulkInsert } = require('./db');

const PROVIDERS_DIR = path.join(__dirname, 'fxProviders');

async function handleFx(ctx, action) {
  switch (action) {
    case 'fx.fetch_rates':          return fetchRates(ctx);
    case 'fx.revaluation_preview':  return revaluationPreview(ctx);
    case 'fx.revaluation_post':     return revaluationPost(ctx);
    case 'fx.rates.list':           return listRates(ctx);
    case 'fx.rates.save':           return saveRates(ctx);
    case 'fx.rates.delete':         return deleteRate(ctx);
    case 'fx.rates.get':            return getEffectiveRate(ctx);
    case 'fx.providers.list':       return listProviders(ctx);
    case 'fx.provider.get':         return getProvider(ctx);
    case 'fx.provider.save':        return saveProvider(ctx);
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

  // Load provider setting
  const providerSettings = await query(
    `SELECT value FROM settings WHERE company_id = @companyId AND key IN ('fx_provider', 'fx_provider_api_key')`,
    { companyId }
  );
  const settingsMap = Object.fromEntries(providerSettings.map(r => [r.key, r.value]));
  const providerName = settingsMap.fx_provider || 'ecb';
  const apiKey = settingsMap.fx_provider_api_key || null;

  const providerPath = path.join(PROVIDERS_DIR, providerName + '.js');
  if (!fs.existsSync(providerPath)) throw Object.assign(new Error(`FX provider not found: ${providerName}`), { code: 'NOT_FOUND' });
  const provider = require(providerPath);

  const rows = await provider.fetchRates(baseCurrency, date, apiKey);

  // Delete existing rows for this date+source
  const rateDate = rows[0]?.date || date;
  const source = rows[0]?.source || providerName;
  await exec(
    `DELETE FROM fx_rates WHERE date = @rateDate AND source = @source AND (from_currency = @base OR to_currency = @base)`,
    { rateDate, source, base: baseCurrency }
  );

  if (rows.length > 0) await bulkInsert('fx_rates', rows);

  return { date: rateDate, baseCurrency, rateCount: rows.length / 2, provider: providerName };
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

async function listRates(ctx) {
  const { companyId, body } = ctx;
  const baseCurrency = body.baseCurrency || null;

  let sql = `SELECT date, from_currency, to_currency, rate, source, fetched_at FROM fx_rates`;
  const params = {};

  if (baseCurrency) {
    sql += ` WHERE (from_currency = @base OR to_currency = @base)`;
    params.base = baseCurrency;
  }

  sql += ` ORDER BY date DESC, from_currency, to_currency LIMIT 500`;

  const rows = await query(sql, params);
  return rows;
}

async function saveRates(ctx) {
  const { companyId, body } = ctx;
  const { rates } = body;

  if (!rates || !Array.isArray(rates)) {
    throw Object.assign(new Error('rates array required'), { code: 'INVALID_INPUT' });
  }

  const now = new Date().toISOString();

  for (const rate of rates) {
    const { date, from_currency, to_currency, rate: rateValue } = rate;
    if (!date || !from_currency || !to_currency || rateValue === undefined) {
      throw Object.assign(new Error('date, from_currency, to_currency, and rate required'), { code: 'INVALID_INPUT' });
    }

    // Delete existing manual rates with same key
    await exec(
      `DELETE FROM fx_rates WHERE date = @date AND from_currency = @from AND to_currency = @to AND source = 'manual'`,
      { date, from: from_currency, to: to_currency }
    );

    // Insert new manual rate
    await bulkInsert('fx_rates', [{
      date,
      from_currency,
      to_currency,
      rate: Number(rateValue),
      source: 'manual',
      fetched_at: now,
    }]);
  }

  return { saved: rates.length };
}

async function deleteRate(ctx) {
  const { companyId, body } = ctx;
  const { date, from_currency, to_currency, source } = body;

  if (!date || !from_currency || !to_currency || !source) {
    throw Object.assign(new Error('date, from_currency, to_currency, and source required'), { code: 'INVALID_INPUT' });
  }

  await exec(
    `DELETE FROM fx_rates WHERE date = @date AND from_currency = @from AND to_currency = @to AND source = @source`,
    { date, from: from_currency, to: to_currency, source }
  );

  return { deleted: true };
}

async function getEffectiveRate(ctx) {
  const { body } = ctx;
  const { fromCurrency, toCurrency, date } = body;

  if (!fromCurrency || !toCurrency || !date) {
    throw Object.assign(new Error('fromCurrency, toCurrency, and date required'), { code: 'INVALID_INPUT' });
  }

  const rate = await getRate(fromCurrency, toCurrency, date);
  if (rate === null) {
    return { rate: null, source: null, rateDate: null };
  }

  // Find the actual row to get source and date
  const rows = await query(
    `SELECT rate, source, date FROM fx_rates WHERE from_currency = @from AND to_currency = @to AND date <= @date ORDER BY date DESC, source = 'manual' DESC LIMIT 1`,
    { from: fromCurrency, to: toCurrency, date }
  );

  if (rows.length === 0) {
    return { rate: null, source: null, rateDate: null };
  }

  return { rate: Number(rows[0].rate), source: rows[0].source, rateDate: rows[0].date };
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

async function listProviders(ctx) {
  const providers = [];
  const files = fs.readdirSync(PROVIDERS_DIR);
  for (const file of files) {
    if (file.endsWith('.js')) {
      const id = file.slice(0, -3);
      const provider = require(path.join(PROVIDERS_DIR, file));
      providers.push({
        id,
        name: provider.name,
        description: provider.description,
        requiresApiKey: provider.requiresApiKey,
        apiKeyLabel: provider.apiKeyLabel
      });
    }
  }
  return providers;
}

async function getProvider(ctx) {
  const { companyId } = ctx;
  const settings = await query(
    `SELECT key, value FROM settings WHERE company_id = @companyId AND key IN ('fx_provider', 'fx_provider_api_key')`,
    { companyId }
  );
  const settingsMap = Object.fromEntries(settings.map(r => [r.key, r.value]));
  const providerName = settingsMap.fx_provider || 'ecb';
  const apiKey = settingsMap.fx_provider_api_key || null;
  const maskedKey = apiKey ? apiKey.slice(-4).padStart(apiKey.length, '*') : null;
  return { provider: providerName, apiKey: maskedKey };
}

async function saveProvider(ctx) {
  const { companyId, body } = ctx;
  const { provider, apiKey } = body;
  if (!provider) throw Object.assign(new Error('provider required'), { code: 'INVALID_INPUT' });

  // Verify provider exists
  const providerPath = path.join(PROVIDERS_DIR, provider + '.js');
  if (!fs.existsSync(providerPath)) throw Object.assign(new Error(`FX provider not found: ${provider}`), { code: 'NOT_FOUND' });

  // Save provider setting
  await exec(
    `DELETE FROM settings WHERE company_id = @companyId AND key = 'fx_provider'`,
    { companyId }
  );
  await bulkInsert('settings', [{
    company_id: companyId,
    key: 'fx_provider',
    value: provider,
    updated_at: new Date().toISOString()
  }]);

  // Save API key if provided
  if (apiKey) {
    await exec(
      `DELETE FROM settings WHERE company_id = @companyId AND key = 'fx_provider_api_key'`,
      { companyId }
    );
    await bulkInsert('settings', [{
      company_id: companyId,
      key: 'fx_provider_api_key',
      value: apiKey,
      updated_at: new Date().toISOString()
    }]);
  }

  return { saved: true, provider };
}

module.exports = { handleFx, getRate, listRates, saveRates, deleteRate, getEffectiveRate };
