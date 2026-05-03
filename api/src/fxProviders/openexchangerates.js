'use strict';

module.exports = {
  name: 'Open Exchange Rates',
  description: 'Requires a free API key from openexchangerates.org. Base currency locked to USD on free plan.',
  requiresApiKey: true,
  apiKeyLabel: 'App ID',

  async fetchRates(baseCurrency, date, apiKey) {
    if (!apiKey) throw new Error('Open Exchange Rates requires an App ID');

    const endpoint = date && date !== 'latest'
      ? `https://openexchangerates.org/api/historical/${date}.json?app_id=${apiKey}`
      : `https://openexchangerates.org/api/latest.json?app_id=${apiKey}`;

    const response = await fetch(endpoint);
    if (!response.ok) throw new Error(`Open Exchange Rates fetch failed: ${response.status}`);

    const data = await response.json();
    const rateDate = data.timestamp ? new Date(data.timestamp * 1000).toISOString().slice(0, 10) : date;
    const now = new Date().toISOString();
    const rows = [];

    // OXR always returns USD base; convert to baseCurrency if different
    const usdToBase = baseCurrency === 'USD' ? 1 : (data.rates[baseCurrency] || null);
    if (!usdToBase) throw new Error(`No USD→${baseCurrency} rate in response`);

    for (const [currency, usdRate] of Object.entries(data.rates)) {
      if (currency === baseCurrency) continue;

      const rate = usdRate / usdToBase;
      rows.push({
        date: rateDate,
        from_currency: baseCurrency,
        to_currency: currency,
        rate: Math.round(rate * 1000000) / 1000000,
        source: 'openexchangerates',
        fetched_at: now
      });
      rows.push({
        date: rateDate,
        from_currency: currency,
        to_currency: baseCurrency,
        rate: Math.round((1 / rate) * 1000000) / 1000000,
        source: 'openexchangerates',
        fetched_at: now
      });
    }

    return rows;
  }
};
