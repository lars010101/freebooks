'use strict';
/**
 * freeBooks — Event emission + event.list (A2, spec §3)
 *
 * `events` is an append-only stream of business facts at state transitions
 * (journal posted, bill posted, payment recorded/voided, attachment uploaded,
 * period locked/unlocked). It is the agent's input channel (poll via
 * event.list) AND the audit narrative, distinct from the per-invocation
 * dispatch audit (audit_log, P0-4).
 *
 * R4 (replay rule): emission happens INSIDE the handlers that own each
 * transition, which only run on an idempotency MISS — the dispatch-level
 * short-circuit returns the stored response before the handler executes, so a
 * replay can never double-emit. Correct by construction; asserted by a
 * contract test.
 */

const { query, exec } = require('./db');

const MAX_PAYLOAD_CHARS = 4000;

/**
 * Insert one event row. Omits event_seq/event_id so the column defaults fire
 * (nextval + uuid()). actor_type/actor_id/request_id come from ctx — the
 * actor class is derived from the DB role (A1 §2.2), never asserted. payload
 * is a compact JSON snapshot, truncated to MAX_PAYLOAD_CHARS if needed.
 *
 * Emission failures are logged but never fail the business request — a
 * broken event stream must not roll back a posted journal. Callers that need
 * stronger guarantees can await this; the convention is to emit AFTER the
 * state transition has committed.
 */
async function emitEvent(ctx, type, entityType, entityId, payload) {
  const companyId = ctx && ctx.companyId;
  if (!companyId || !type || !entityType || !entityId) {
    // Defensive: never throw on a misconfigured call site — log and skip.
    console.warn('emitEvent: missing required field, skipping', { type, entityType, entityId, companyId });
    return null;
  }
  const actor = (ctx && ctx.actor) || { actorType: 'human' };
  // request_id: ctx.requestId per spec §3.1 (set in handleApiRequest from
  // body.requestId or X-Request-Id). Fall back to actor.requestId for symmetry
  // with audit.js' actor-arg convention in case a caller bundles it there.
  const requestId = (ctx.requestId != null ? String(ctx.requestId)
    : (actor.requestId != null ? String(actor.requestId) : null));
  let payloadJson = null;
  if (payload !== undefined && payload !== null) {
    try {
      payloadJson = JSON.stringify(payload);
    } catch {
      payloadJson = JSON.stringify(String(payload));
    }
    if (payloadJson.length > MAX_PAYLOAD_CHARS) {
      payloadJson = payloadJson.slice(0, MAX_PAYLOAD_CHARS);
    }
  }
  try {
    await exec(
      `INSERT INTO events (company_id, event_type, entity_type, entity_id, actor_type, actor_id, request_id, payload)
       VALUES (@companyId, @type, @entityType, @entityId, @actorType, @actorId, @requestId, @payload)`,
      {
        companyId,
        type,
        entityType,
        entityId: String(entityId),
        actorType: actor.actorType || 'human',
        actorId: (ctx.userEmail != null ? String(ctx.userEmail) : null),
        requestId,
        payload: payloadJson,
      }
    );
  } catch (err) {
    // Append-only stream must not fail the business request. Log loudly.
    console.error(`emitEvent failed (${type} for ${entityType}/${entityId}):`, err.message);
  }
  return null;
}

/**
 * event.list — the agent's input channel (spec §3.3).
 * Viewer role, non-mutating. Params:
 *   after_seq (number, default 0) — return only rows with event_seq > after_seq
 *   type      (string, optional)  — filter on event_type
 *   limit     (number, default 100, capped at 500)
 * Rows ordered by event_seq ASC, scoped to ctx.companyId.
 *
 * Polling contract: the caller keeps the highest event_seq seen and passes it
 * as after_seq on the next poll. Monotonic, gap-safe, replay-safe.
 */
async function handleEvents(ctx, action) {
  if (action !== 'event.list') {
    throw Object.assign(new Error(`Unknown event action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
  const { companyId, body } = ctx;
  const afterSeq = Number(body.after_seq) > 0 ? Math.floor(Number(body.after_seq)) : 0;
  const typeFilter = body.type && String(body.type).trim() !== '' ? String(body.type).trim() : null;
  const rawLimit = Number(body.limit);
  const limit = (Number.isFinite(rawLimit) && rawLimit > 0) ? Math.min(Math.floor(rawLimit), 500) : 100;

  let sql = `SELECT event_seq, event_id, company_id, event_type, entity_type, entity_id,
                    actor_type, actor_id, request_id, payload, created_at
             FROM events
             WHERE company_id = @companyId AND event_seq > @afterSeq`;
  const params = { companyId, afterSeq };
  if (typeFilter) {
    sql += ` AND event_type = @type`;
    params.type = typeFilter;
  }
  sql += ` ORDER BY event_seq ASC LIMIT @limit`;
  params.limit = limit;

  return query(sql, params);
}

module.exports = { emitEvent, handleEvents, MAX_PAYLOAD_CHARS };
