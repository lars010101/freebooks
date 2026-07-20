'use strict';
const { makeQuery } = require('./common');

async function handleAdminQuery(req, res) {
  // P0-5: arbitrary SQL requires the FREEBOOKS_ADMIN_TOKEN bearer token.
  // When the env var is unset the endpoint is disabled entirely — this route
  // executes arbitrary SQL and must never be open by default.
  const adminToken = process.env.FREEBOOKS_ADMIN_TOKEN || '';
  if (!adminToken) {
    return res.status(403).json({ error: 'Admin query is disabled (set FREEBOOKS_ADMIN_TOKEN to enable)' });
  }
  if ((req.get('authorization') || '') !== `Bearer ${adminToken}`) {
    return res.status(403).json({ error: 'Forbidden' });
  }
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
