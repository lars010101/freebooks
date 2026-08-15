'use strict';
/**
 * freeBooks — Cost/Profit Center derivation helpers
 *
 * Spec: /home/ubuntu/cost-profit-center-spec.md (rev 4)
 *
 * deriveProfitCenter: given a cost_center_id, returns the profit_center_id
 * it's assigned to. Throws if the cost center doesn't exist, is inactive
 * (unless allowInactive is set), or has no profit_center_id set.
 *
 * isDerivationEnabled: reads the `center_derivation_enabled` settings flag.
 * Every posting-path call site and center.save check this before doing
 * anything derivation-related — it's the single switch for the feature.
 */

const { query } = require('./db');

/**
 * Given a cost_center_id, returns the profit_center_id it's assigned to.
 * Throws if the cost center doesn't exist, is inactive (unless allowInactive
 * is set — see below), or has no profit_center_id set.
 *
 * allowInactive: pass true only from correction/reversal paths (editing or
 * reclassing an entry that already references a since-deactivated cost
 * center). Default false blocks NEW postings against an inactive center but
 * doesn't trap you when fixing something that already used it. Chosen over
 * the alternative of forbidding deactivation while historical references
 * exist — that would require a reference-count check on every deactivate
 * and doesn't handle centers deactivated via CSV import (db/import.js)
 * outside the app layer.
 *
 * Callers MUST check isDerivationEnabled() before calling this in a posting
 * path (§4) — this function itself doesn't check the flag, so calling it
 * unconditionally will throw for any Cost center that hasn't been backfilled
 * yet, even during the intentionally-permissive pre-cutover window.
 */
async function deriveProfitCenter(companyId, costCenterId, { allowInactive = false } = {}) {
  if (!costCenterId) return null;
  const [center] = await query(
    `SELECT center_type, profit_center_id, is_active
     FROM centers WHERE company_id = @companyId AND center_id = @centerId`,
    { companyId, centerId: costCenterId }
  );
  if (!center) throw new Error(`Unknown cost_center: ${costCenterId}`);
  if (center.center_type !== 'Cost') {
    throw new Error(`${costCenterId} is not a Cost center`);
  }
  if (!center.is_active && !allowInactive) {
    throw new Error(`Cost center ${costCenterId} is inactive`);
  }
  if (!center.profit_center_id) {
    throw new Error(`Cost center ${costCenterId} has no profit center assigned`);
  }
  return center.profit_center_id;
}

/**
 * Reads the rollout gate from §2. Every posting-path call site (§4) and
 * center.save (§6a) call this before doing anything derivation-related —
 * it's the single switch for the whole feature. No caching across requests:
 * an owner can flip it at any time via settings.save, and the next request
 * should see it immediately.
 */
async function isDerivationEnabled(companyId) {
  const [row] = await query(
    `SELECT value FROM settings WHERE company_id = @companyId AND key = 'center_derivation_enabled'`,
    { companyId }
  );
  return row?.value === 'true';
}

module.exports = { deriveProfitCenter, isDerivationEnabled };
