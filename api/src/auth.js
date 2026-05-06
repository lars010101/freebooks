'use strict';
/**
 * freeBooks — Permission checking
 * Role hierarchy: owner > data_entry > viewer
 */

const { query } = require('./db');

const ROLE_HIERARCHY = {
  owner: 3,
  data_entry: 2,
  viewer: 1,
};

// Simple TTL cache — permissions rarely change in a personal app
const _permCache = new Map();
const PERM_CACHE_TTL_MS = 60_000;

async function checkPermission(email, companyId, requiredRole) {
  if (!email) return false;

  const cacheKey = `${email}:${companyId}:${requiredRole}`;
  const cached = _permCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const rows = await query(
    `SELECT role FROM user_permissions
     WHERE email = @email AND (company_id = @companyId OR company_id = '*')
     ORDER BY CASE role WHEN 'owner' THEN 3 WHEN 'data_entry' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END DESC
     LIMIT 1`,
    { email, companyId }
  );

  const userLevel = rows.length > 0 ? (ROLE_HIERARCHY[rows[0].role] || 0) : 0;
  const requiredLevel = ROLE_HIERARCHY[requiredRole] || 0;
  const result = userLevel >= requiredLevel;

  _permCache.set(cacheKey, { result, expiresAt: Date.now() + PERM_CACHE_TTL_MS });
  return result;
}

module.exports = { checkPermission };
