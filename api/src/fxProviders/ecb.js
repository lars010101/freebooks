'use strict';

module.exports = {
  name: 'European Central Bank (ECB)',
  description: 'Free, no API key required. Rates published on ECB business days via frankfurter.app.',
  requiresApiKey: false,
  apiKeyLabel: null,

  async fetchRates(baseCurrency, date, apiKey) {
    const url = date && date !== 'latest'
      ? `https://api.frankfurter.app/${date}?from=${baseCurrency}`
      : `https://api.frankfurter.app/latest?from=${baseCurrency}`;

    const response = await fetch(url);
    if (!response.ok) throw new Error(`ECB fetch failed: ${response.status}`);

    const data = await response.json();
    const rateDate = data.date;
    const now = new Date().toISOString();
    const rows = [];

    for (const [currency, rate] of Object.entries(data.rates)) {
      rows.push({
        date: rateDate,
        from_currency: baseCurrency,
        to_currency: currency,
        rate,
        source: 'ecb',
        fetched_at: now
      });
      rows.push({
        date: rateDate,
        from_currency: currency,
        to_currency: baseCurrency,
        rate: Math.round((1 / rate) * 1000000) / 1000000,
        source: 'ecb',
        fetched_at: now
      });
    }

    return rows;
  },

  // fx-automation-spec §2: fetchRange — one call per period returns every
  // published day via frankfurter's range endpoint. Also the efficient
  // backfill mechanism and the ground-truth publication calendar.
  async fetchRange(baseCurrency, startDate, endDate, apiKey) {
    const url = `https://api.frankfurter.app/${startDate}..${endDate}?from=${baseCurrency}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`ECB fetchRange failed: ${response.status}`);

    const data = await response.json();
    const now = new Date().toISOString();
    const rows = [];

    // frankfurter returns { rates: { 'YYYY-MM-DD': { CUR: rate, ... }, ... } }
    for (const [rateDate, rates] of Object.entries(data.rates)) {
      for (const [currency, rate] of Object.entries(rates)) {
        rows.push({
          date: rateDate,
          from_currency: baseCurrency,
          to_currency: currency,
          rate,
          source: 'ecb',
          fetched_at: now
        });
        rows.push({
          date: rateDate,
          from_currency: currency,
          to_currency: baseCurrency,
          rate: Math.round((1 / rate) * 1000000) / 1000000,
          source: 'ecb',
          fetched_at: now
        });
      }
    }

    return rows;
  }
};
