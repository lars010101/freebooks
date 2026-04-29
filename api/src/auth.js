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

async function checkPermission(email, companyId, requiredRole) {
  if (!email) return false;

  const rows = await query(
    `SELECT role FROM user_permissions
     WHERE email = @email AND (company_id = @companyId OR company_id = '*')
     ORDER BY CASE role WHEN 'owner' THEN 3 WHEN 'data_entry' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END DESC
     LIMIT 1`,
    { email, companyId }
  );

  if (rows.length === 0) return false;

  const userLevel = ROLE_HIERARCHY[rows[0].role] || 0;
  const requiredLevel = ROLE_HIERARCHY[requiredRole] || 0;
  return userLevel >= requiredLevel;
}

module.exports = { checkPermission, ROLE_HIERARCHY };
