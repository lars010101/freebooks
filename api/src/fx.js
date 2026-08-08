'use strict';
/**
 * freeBooks — FX rate service
 * Ported from BigQuery Cloud Function to DuckDB/Express.
 */

const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const { query, exec, bulkInsert } = require('./db');
const { fxRevaluationConfigFor } = require('./jurisdiction-packs');

const PROVIDERS_DIR = path.join(__dirname, 'fxProviders');

// FX provider config is PER-COMPANY (fx-automation-spec rev. 3, 2026-07-27 —
// supersedes the install-level era): each company chooses a provider or
// 'manual' (no automatic download). The rate table stays global; fetches are
// idempotent per date+source (delete-then-insert), so two companies sharing a
// provider cannot corrupt each other's rows.
const INSTALL_COMPANY_ID = '__install__'; // legacy scope — adopted + deleted on first read
const MANUAL_PROVIDER = 'manual';

function providerExists(name) {
  return fs.existsSync(path.join(PROVIDERS_DIR, name + '.js'));
}

function listProviderIds() {
  return fs.readdirSync(PROVIDERS_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => f.slice(0, -3));
}

// loadProviderConfig — per-company settings rows (fx_provider,
// fx_provider_api_key). One-time upgrade from the install-level era: when the
// company has no row yet but a legacy `__install__` config exists, the company
// ADOPTS it (copied down, install rows deleted). Default when nothing is
// configured anywhere: 'manual' — no surprise network calls; the company opts
// into a real provider explicitly.
async function loadProviderConfig(companyId) {
  let rows = await query(
    `SELECT key, value FROM settings WHERE company_id = @companyId AND key IN ('fx_provider', 'fx_provider_api_key')`,
    { companyId }
  );
  if (rows.length === 0) {
    const installRows = await query(
      `SELECT key, value FROM settings WHERE company_id = @installId AND key IN ('fx_provider', 'fx_provider_api_key')`,
      { installId: INSTALL_COMPANY_ID }
    );
    if (installRows.length > 0) {
      const now = new Date().toISOString();
      for (const r of installRows) {
        await bulkInsert('settings', [{ company_id: companyId, key: r.key, value: r.value, updated_at: now }]);
      }
      await exec(
        `DELETE FROM settings WHERE company_id = @installId AND key IN ('fx_provider', 'fx_provider_api_key')`,
        { installId: INSTALL_COMPANY_ID }
      );
      rows = installRows;
    }
  }
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    providerName: map.fx_provider || MANUAL_PROVIDER,
    apiKey: map.fx_provider_api_key || null,
    source: 'company'
  };
}

async function handleFx(ctx, action) {
  switch (action) {
    case 'fx.fetch_rates':          return fetchRates(ctx);
    case 'fx.revaluation_preview':  return revaluationPreview(ctx);
    case 'fx.revaluation_post':     return revaluationPost(ctx);
    case 'fx.rates.list':           return listRates(ctx);
    case 'fx.rates.save':           return saveRates(ctx);
    case 'fx.rates.delete':         return deleteRate(ctx);
    case 'fx.rates.get':            return getEffectiveRate(ctx);
    case 'fx.coverage':             return coverageAction(ctx);
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

  // Load provider config — per-company (fx-automation-spec rev 3): 'manual'
  // means no automatic download for this company.
  const { providerName, apiKey } = await loadProviderConfig(companyId);
  if (providerName === MANUAL_PROVIDER) {
    throw Object.assign(
      new Error('FX provider is set to Manual for this company — automatic download is disabled (Settings → Company → FX Provider).'),
      { code: 'INVALID_STATE' }
    );
  }

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

  // --- Forward direction: from -> to ---
  const exact = await query(
    `SELECT rate FROM fx_rates WHERE from_currency = @from AND to_currency = @to AND date = @date ORDER BY source = 'manual' DESC, fetched_at DESC LIMIT 1`,
    { from: fromCurrency, to: toCurrency, date }
  );
  if (exact.length > 0) return Number(exact[0].rate);

  // --- Reverse direction: to -> from (invert the rate) ---
  // If USD->SGD is not found, try SGD->USD and return 1 / rate.
  const exactReverse = await query(
    `SELECT rate FROM fx_rates WHERE from_currency = @to AND to_currency = @from AND date = @date ORDER BY source = 'manual' DESC, fetched_at DESC LIMIT 1`,
    { from: fromCurrency, to: toCurrency, date }
  );
  if (exactReverse.length > 0) return 1.0 / Number(exactReverse[0].rate);

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
    const { date, from_currency, to_currency, rate: rateValue, original } = rate;
    if (!date || !from_currency || !to_currency || rateValue === undefined) {
      throw Object.assign(new Error('date, from_currency, to_currency, and rate required'), { code: 'INVALID_INPUT' });
    }

    if (original && original.date && original.from_currency && original.to_currency && original.source) {
      // User edited an existing register row: replace the ORIGINAL row (any
      // source, e.g. ecb) — the write flips it to 'manual' instead of leaving
      // a duplicate alongside the provider-sourced one (2026-07-23).
      await exec(
        `DELETE FROM fx_rates WHERE date = @d AND from_currency = @f AND to_currency = @t AND source = @s`,
        { d: original.date, f: original.from_currency, t: original.to_currency, s: original.source }
      );
    } else {
      // Delete existing manual rates with same key
      await exec(
        `DELETE FROM fx_rates WHERE date = @date AND from_currency = @from AND to_currency = @to AND source = 'manual'`,
        { date, from: from_currency, to: to_currency }
      );
    }

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
    return { rate: null, source: null, rateDate: null, direction: null };
  }

  // Find the actual row to get source and date — exact date only.
  let rows = await query(
    `SELECT rate, source, date FROM fx_rates WHERE from_currency = @from AND to_currency = @to AND date = @date ORDER BY source = 'manual' DESC, fetched_at DESC LIMIT 1`,
    { from: fromCurrency, to: toCurrency, date }
  );
  let direction = 'direct';
  if (rows.length === 0) {
    rows = await query(
      `SELECT rate, source, date FROM fx_rates WHERE from_currency = @to AND to_currency = @from AND date = @date ORDER BY source = 'manual' DESC, fetched_at DESC LIMIT 1`,
      { from: fromCurrency, to: toCurrency, date }
    );
    direction = 'inverted';
  }

  if (rows.length === 0) {
    return { rate: null, source: null, rateDate: null, direction: null };
  }

  return { rate, source: rows[0].source, rateDate: rows[0].date, direction };
}

async function revaluationPreview(ctx) {
  const { companyId, body } = ctx;
  const { revalDate } = body;
  if (!revalDate) throw Object.assign(new Error('revalDate required'), { code: 'INVALID_INPUT' });

  const companies = await query(`SELECT currency, jurisdiction FROM companies WHERE company_id = @companyId LIMIT 1`, { companyId });
  const homeCurrency = companies[0].currency;
  const jurisdiction = companies[0].jurisdiction;

  // Pack-driven monetary types (P2-2): default to Asset+Liability only (IAS 21 —
  // monetary items). Equity is never revalued. The pack can narrow further.
  const fxConfig = fxRevaluationConfigFor(jurisdiction);
  const monetaryTypes = (fxConfig && fxConfig.monetaryTypes) || ['Asset', 'Liability'];

  // Build IN clause with named params (DuckDB @param → $param binding)
  const typeParams = {};
  const typePlaceholders = monetaryTypes.map((t, i) => {
    typeParams[`mt${i}`] = t;
    return `@mt${i}`;
  });
  const inClause = typePlaceholders.join(', ');

  const balances = await query(
    `SELECT je.account_code, a.account_name, je.currency,
            SUM(je.debit - je.credit) AS foreign_balance,
            SUM(je.debit_home - je.credit_home) AS home_balance
     FROM journal_entries je
     JOIN accounts a ON je.company_id = a.company_id AND je.account_code = a.account_code
     WHERE je.company_id = @companyId
       AND je.date <= @revalDate
       AND je.currency != @homeCurrency
       AND a.account_type IN (${inClause})
     GROUP BY je.account_code, a.account_name, je.currency
     HAVING SUM(je.debit - je.credit) != 0`,
    { companyId, revalDate, homeCurrency, ...typeParams }
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
  const { revalDate, adjustments } = body;
  if (!revalDate || !adjustments) {
    throw Object.assign(new Error('revalDate and adjustments required'), { code: 'INVALID_INPUT' });
  }

  const companies = await query(`SELECT currency, jurisdiction FROM companies WHERE company_id = @companyId LIMIT 1`, { companyId });
  const homeCurrency = companies[0].currency;
  const jurisdiction = companies[0].jurisdiction;

  // Pack-driven default gain/loss account (P2-2): if the caller doesn't pass
  // fxGainLossAccount, fall back to the jurisdiction pack's configured account.
  const fxConfig = fxRevaluationConfigFor(jurisdiction);
  const gainLossAccount = body.fxGainLossAccount || (fxConfig && fxConfig.gainLossAccount);
  if (!gainLossAccount) {
    throw Object.assign(new Error('fxGainLossAccount required (or set fxRevaluation.gainLossAccount in the jurisdiction pack)'), { code: 'INVALID_INPUT' });
  }

  const batchId = uuid();
  const now = new Date().toISOString();
  const lines = [];

  for (const adj of adjustments) {
    if (!adj.fxGainLoss || Math.abs(adj.fxGainLoss) < 0.01) continue;
    const isGain = adj.fxGainLoss > 0;
    const amount = Math.abs(adj.fxGainLoss);

    const base = { company_id: companyId, batch_id: batchId, date: revalDate, currency: homeCurrency, fx_rate: 1.0, vat_code: null, vat_amount: 0, vat_amount_home: 0, net_amount: 0, net_amount_home: 0, source: 'fx_revaluation', cost_center: null, profit_center: null, reverses: null, reversed_by: null, bill_id: null, created_by: userEmail, created_at: now };

    lines.push({ ...base, entry_id: uuid(), account_code: adj.accountCode, debit: isGain ? amount : 0, credit: isGain ? 0 : amount, debit_home: isGain ? amount : 0, credit_home: isGain ? 0 : amount, description: `FX revaluation: ${adj.accountCode} ${adj.currency}`, reference: `FXREVAL-${revalDate}` });
    lines.push({ ...base, entry_id: uuid(), account_code: gainLossAccount, debit: isGain ? 0 : amount, credit: isGain ? amount : 0, debit_home: isGain ? 0 : amount, credit_home: isGain ? amount : 0, description: `FX ${isGain ? 'gain' : 'loss'}: ${adj.accountCode} ${adj.currency}`, reference: `FXREVAL-${revalDate}` });
  }

  if (lines.length > 0) await bulkInsert('journal_entries', lines);

  return { posted: true, batchId, lineCount: lines.length, totalGainLoss: adjustments.reduce((s, a) => s + (a.fxGainLoss || 0), 0) };
}

// ── fx.coverage (fx-automation-spec §3) ─────────────────────────────────────
// Coverage = stored days vs the provider's actual publication days — never
// naive weekdays. Returns per-period: { status, missing, publicationDays }.
async function coverageAction(ctx) {
  const { companyId, body } = ctx;
  const { startDate, endDate } = body;
  if (!startDate || !endDate) {
    throw Object.assign(new Error('startDate and endDate required'), { code: 'INVALID_INPUT' });
  }

  const companies = await query(
    `SELECT currency FROM companies WHERE company_id = @companyId LIMIT 1`,
    { companyId }
  );
  if (companies.length === 0) throw Object.assign(new Error('Company not found'), { code: 'NOT_FOUND' });
  const baseCurrency = companies[0].currency;

  const { providerName, apiKey } = await loadProviderConfig(companyId);

  // If tracking is off or provider is manual → na
  const trackingRows = await query(
    `SELECT value FROM settings WHERE company_id = @companyId AND key = 'fx_tracking'`,
    { companyId }
  );
  const tracking = trackingRows.length > 0 ? trackingRows[0].value : 'auto';
  if (tracking === 'off' || providerName === MANUAL_PROVIDER) {
    return { status: 'na', missing: [], reason: 'FX tracking off or provider is manual' };
  }

  if (!providerExists(providerName)) {
    return { status: 'na', missing: [], reason: `Provider not found: ${providerName}` };
  }

  const provider = require(path.join(PROVIDERS_DIR, providerName + '.js'));
  const { computeCoverage } = require('./fx-coverage');

  const today = new Date().toISOString().slice(0, 10);
  const effectiveEnd = endDate < today ? endDate : today;

  const result = await computeCoverage(companyId, baseCurrency, startDate, effectiveEnd, provider, providerName);
  return result;
}

// ── Period hook backfill (fx-automation-spec §4) ────────────────────────────
// Called after period.upsert when fx_tracking='auto' and provider is real.
// Fire-and-forget: the caller (period.upsert) never waits on this.
async function backfillPeriod(companyId, periodStart, periodEnd) {
  try {
    const { providerName, apiKey } = await loadProviderConfig(companyId);
    if (providerName === MANUAL_PROVIDER || !providerExists(providerName)) return;

    const trackingRows = await query(
      `SELECT value FROM settings WHERE company_id = @companyId AND key = 'fx_tracking'`,
      { companyId }
    );
    const tracking = trackingRows.length > 0 ? trackingRows[0].value : 'auto';
    if (tracking === 'off') return;

    const companies = await query(
      `SELECT currency FROM companies WHERE company_id = @companyId LIMIT 1`,
      { companyId }
    );
    if (companies.length === 0) return;
    const baseCurrency = companies[0].currency;

    const provider = require(path.join(PROVIDERS_DIR, providerName + '.js'));
    const { fetchRange: doFetchRange } = require('./fx-coverage');

    const today = new Date().toISOString().slice(0, 10);
    const effectiveEnd = periodEnd < today ? periodEnd : today;

    if (periodStart > today) return; // future period

    const rows = await doFetchRange(provider, baseCurrency, periodStart, effectiveEnd, apiKey);
    if (rows && rows.length > 0) {
      const source = rows[0].source || providerName;
      const dates = [...new Set(rows.map(r => r.date))];
      for (const d of dates) {
        await exec(
          `DELETE FROM fx_rates WHERE date = @date AND source = @source AND (from_currency = @base OR to_currency = @base)`,
          { date: d, source, base: baseCurrency }
        );
      }
      await bulkInsert('fx_rates', rows);
    }
  } catch (e) {
    // Fire-and-forget: never throw to the caller
    console.error(`FX period backfill failed for ${companyId}:`, e.message);
  }
}

async function listProviders(ctx) {
  // 'manual' is a first-class provider choice (fx-automation-spec rev. 3):
  // no automatic download — rates are entered by hand (source='manual').
  const providers = [{
    id: MANUAL_PROVIDER,
    name: 'Manual (no auto-download)',
    description: 'Rates are entered manually on the Exchange Rates tab; nothing is downloaded automatically.',
    requiresApiKey: false
  }];
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
  // Per-company (fx-automation-spec rev. 3): no install-level fallback beyond
  // the one-time adoption inside loadProviderConfig.
  const { providerName, apiKey, source } = await loadProviderConfig(companyId);
  const maskedKey = apiKey ? apiKey.slice(-4).padStart(apiKey.length, '*') : null;
  return { provider: providerName, apiKey: maskedKey, source };
}

async function saveProvider(ctx) {
  const { companyId, body } = ctx;
  const { provider, apiKey } = body;
  if (!provider) throw Object.assign(new Error('provider required'), { code: 'INVALID_INPUT' });

  // 'manual' is always valid; anything else must be a real provider file.
  if (provider !== MANUAL_PROVIDER && !providerExists(provider)) {
    throw Object.assign(new Error(`FX provider not found: ${provider}`), { code: 'NOT_FOUND' });
  }

  // Per-company config (fx-automation-spec rev. 3): delete + insert the
  // company's own settings rows — never an install-scoped row.
  const now = new Date().toISOString();
  await exec(
    `DELETE FROM settings WHERE company_id = @companyId AND key = 'fx_provider'`,
    { companyId }
  );
  await bulkInsert('settings', [{
    company_id: companyId,
    key: 'fx_provider',
    value: provider,
    updated_at: now
  }]);

  // Save API key if provided. An empty string keeps the stored key (the grid's
  // masked display means a blank edit is never a clear-intent).
  if (apiKey !== undefined && apiKey !== null && apiKey !== '') {
    await exec(
      `DELETE FROM settings WHERE company_id = @companyId AND key = 'fx_provider_api_key'`,
      { companyId }
    );
    await bulkInsert('settings', [{
      company_id: companyId,
      key: 'fx_provider_api_key',
      value: apiKey,
      updated_at: now
    }]);
  }

  return { saved: true, provider };
}

module.exports = { handleFx, getRate, listRates, saveRates, deleteRate, getEffectiveRate, loadProviderConfig, providerExists, listProviderIds, MANUAL_PROVIDER, backfillPeriod };
