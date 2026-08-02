'use strict';
/**
 * freeBooks — per-actor API tokens (agent-readiness spec §2.6).
 * auth.token.create / auth.token.list / auth.token.revoke. The token string
 * is shown ONCE at creation; only its sha256 hex is stored. Tokens are
 * install-global (bound to an email, not a company): per-company access is
 * still enforced by user_permissions on every call, exactly as for
 * self-asserted identity.
 */
const { query } = require('./db');
const { mintToken, hashToken } = require('./auth');

async function handleTokens(ctx, action) {
  const { body } = ctx;

  switch (action) {
    case 'auth.token.create': {
      const email = (body.email || '').trim();
      const label = (body.label || '').trim();
      if (!email || !label) {
        throw Object.assign(new Error('email and label are required'), { code: 'INVALID_INPUT' });
      }
      const token = mintToken();
      const rows = await query(
        `INSERT INTO api_tokens (token_hash, label, email, created_by)
         VALUES (@hash, @label, @email, @by)
         RETURNING token_id`,
        { hash: hashToken(token), label, email, by: ctx.userEmail || null }
      );
      const tokenId = rows[0]?.token_id;
      // Token shown ONCE — only its sha256 hex is persisted.
      return { tokenId, token, email, label };
    }

    case 'auth.token.list': {
      // NEVER select token_hash — it is not a credential and never leaves storage.
      return query(
        `SELECT token_id, label, email, created_at, created_by, revoked_at, revoked_by
         FROM api_tokens
         ORDER BY created_at DESC`
      );
    }

    case 'auth.token.revoke': {
      const tokenId = body.tokenId;
      // catalog enforces tokenId required; guard anyway for direct callers.
      if (!tokenId) {
        throw Object.assign(new Error('tokenId is required'), { code: 'INVALID_INPUT' });
      }
      const updated = await query(
        `UPDATE api_tokens SET revoked_at = now(), revoked_by = @by
         WHERE token_id = @id AND revoked_at IS NULL
         RETURNING token_id`,
        { id: tokenId, by: ctx.userEmail || null }
      );
      if (updated.length > 0) {
        return { tokenId, revoked: true };
      }
      // No row updated: either already revoked, or no such token.
      const found = await query(
        `SELECT token_id, revoked_at FROM api_tokens WHERE token_id = @id`,
        { id: tokenId }
      );
      if (found.length > 0) {
        // Handler-level idempotent: revoking an already-revoked token is a no-op success.
        return { tokenId, revoked: true, alreadyRevoked: true };
      }
      throw Object.assign(new Error(`API token not found: ${tokenId}`), { code: 'NOT_FOUND' });
    }

    default:
      throw Object.assign(new Error(`Unknown tokens action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

module.exports = { handleTokens };
