'use strict';
/**
 * freeBooks — Permission checking + actor resolution (A1)
 * Role hierarchy: owner > data_entry > agent > viewer
 *
 * `agent` (level 1.5) sits above `viewer` (agents read everything a viewer
 * can) and below `data_entry` (every existing data_entry action rejects agents
 * at the numeric check, unchanged — spec §2.1).
 *
 * Per-actor API tokens (agent-readiness spec §2.6): a Bearer token
 * authenticates identity; the role still resolves from user_permissions per
 * call. The token string is shown ONCE at creation; only its sha256 hex is
 * stored.
 */

const crypto = require('crypto');
const { query } = require('./db');

// ── Per-actor API tokens (spec §2.6) ────────────────────────────────────────
const TOKEN_PREFIX = 'fbt_';

/** Mint a fresh token string (TOKEN_PREFIX + 24 random bytes hex). */
function mintToken() {
  return TOKEN_PREFIX + crypto.randomBytes(24).toString('hex');
}

/** sha256 hex of a presented token — the only form persisted to api_tokens. */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Resolve a presented Bearer token to its stored identity. Returns null for
 * empty/invalid/revoked tokens — callers must treat null as authentication
 * failure (never fall back to self-asserted identity: that's a downgrade hole).
 */
async function resolveToken(presented) {
  if (!presented || typeof presented !== 'string') return null;
  const rows = await query(
    `SELECT token_id, label, email FROM api_tokens WHERE token_hash = @hash AND revoked_at IS NULL`,
    { hash: hashToken(presented) }
  );
  return rows.length > 0 ? { tokenId: rows[0].token_id, label: rows[0].label, email: rows[0].email } : null;
}

/** True iff req originates from the loopback address (same-host client). */
function isLoopbackRequest(req) {
  const addr = (req && req.socket && req.socket.remoteAddress) || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/**
 * In 'token-remote' auth mode, non-loopback clients must present a valid
 * Bearer token (the two-server deployment mode). Loopback keeps the legacy
 * install-level trust.
 */
function remoteTokenRequired(authMode, req) {
  return authMode === 'token-remote' && !isLoopbackRequest(req);
}

const ROLE_HIERARCHY = {
  owner: 3,
  data_entry: 2,
  agent: 1.5,
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
     ORDER BY CASE role WHEN 'owner' THEN 3 WHEN 'data_entry' THEN 2 WHEN 'agent' THEN 1.5 WHEN 'viewer' THEN 1 ELSE 0 END DESC
     LIMIT 1`,
    { email, companyId }
  );

  const userLevel = rows.length > 0 ? (ROLE_HIERARCHY[rows[0].role] || 0) : 0;
  const requiredLevel = ROLE_HIERARCHY[requiredRole] || 0;
  const result = userLevel >= requiredLevel;

  _permCache.set(cacheKey, { result, expiresAt: Date.now() + PERM_CACHE_TTL_MS });
  return result;
}

/**
 * A1 (§2.2): resolve the actor behind a call. The class comes from the
 * database role, never from anything in the request — an agent cannot
 * self-assert its way to `human`. `actorType = role === 'agent' ? 'agent'
 * : 'human'`. Same 60s TTL cache pattern as checkPermission.
 *
 * Returns null (actorType 'human', role null) for an unknown/unauthenticated
 * email so the existing "no userEmail" path keeps its legacy behavior.
 */
async function resolveActor(email, companyId) {
  const defaultActor = { role: null, actorType: 'human' };
  if (!email) return defaultActor;

  const cacheKey = `actor:${email}:${companyId || '*'}`;
  const cached = _permCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  let role = null;
  if (companyId) {
    const rows = await query(
      `SELECT role FROM user_permissions
       WHERE email = @email AND (company_id = @companyId OR company_id = '*')
       ORDER BY CASE role WHEN 'owner' THEN 3 WHEN 'data_entry' THEN 2 WHEN 'agent' THEN 1.5 WHEN 'viewer' THEN 1 ELSE 0 END DESC
       LIMIT 1`,
      { email, companyId }
    );
    if (rows.length > 0) role = rows[0].role;
  } else {
    // No company context (setup.* actions skip companyId) — resolve the
    // actor's highest role across ALL companies. A user whose highest role
    // anywhere is 'agent' is an agent actor, so the §2.3 setup.* guard
    // fires; an owner/data_entry anywhere is trusted for setup.* (they
    // already bypass the role check for setup.* by design).
    const rows = await query(
      `SELECT role FROM user_permissions
       WHERE email = @email
       ORDER BY CASE role WHEN 'owner' THEN 3 WHEN 'data_entry' THEN 2 WHEN 'agent' THEN 1.5 WHEN 'viewer' THEN 1 ELSE 0 END DESC
       LIMIT 1`,
      { email }
    );
    if (rows.length > 0) role = rows[0].role;
  }

  const result = { role, actorType: role === 'agent' ? 'agent' : 'human' };
  _permCache.set(cacheKey, { result, expiresAt: Date.now() + PERM_CACHE_TTL_MS });
  return result;
}

module.exports = {
  checkPermission,
  resolveActor,
  mintToken,
  hashToken,
  resolveToken,
  isLoopbackRequest,
  remoteTokenRequired,
  ROLE_HIERARCHY,
};
