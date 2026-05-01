'use strict';
const { makeQuery } = require('./common');

async function handleAdminQuery(req, res) {
  const { sql, params = [] } = req.body || {};
  if (!sql) return res.status(400).json({ error: 'Missing sql' });
  try {
    const q = makeQuery();
    const rows = await q(sql, params);
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = { handleAdminQuery };
