'use strict';
/**
 * freeBooks — Global search endpoint (command-bar-ux-spec.md §4).
 *
 * GET /api/:company/search?q=<query>&scope=<partner|account|journal|bill|all>
 *
 * Searches a curated identity-field index across the four entity types
 * (partners, accounts, journal batches, bills). The `all` scope unions the
 * same per-scope queries; letter prefixes (/p:, /a:, /j:, /b:) narrow it.
 *
 * Non-entity tables (audit_log, events, api_tokens, …) are out of scope.
 */

const { query } = require('./db');

const PER_SCOPE_CAP = 10;
const TOTAL_CAP = 30;
const VALID_SCOPES = new Set(['partner', 'account', 'journal', 'bill', 'all']);

/**
 * Escape a user-supplied substring for safe embedding in a DuckDB ILIKE
 * pattern. We use named @param binding for the value itself (so the value is
 * never interpolated into SQL), but the %/_ wildcards are wrapped around it
 * server-side — so we must escape LIKE-special chars in the query text so a
 * user typing `%` or `_` doesn't widen the match unintentionally.
 */
function _likeEscape(s) {
  return String(s).replace(/[%_\\]/g, '\\$&');
}

async function _searchPartners(company, q) {
  const like = '%' + _likeEscape(q) + '%';
  const rows = await query(
    `SELECT partner_id, name
       FROM partners
      WHERE company_id = @company
        AND name ILIKE @like ESCAPE '\\'
        AND is_active = true
      ORDER BY name
      LIMIT ${PER_SCOPE_CAP}`,
    { company, like }
  );
  return rows.map(function (r) {
    return {
      type: 'partner',
      id: r.partner_id,
      label: r.name,
      route: '/master-data?tab=partners'
    };
  });
}

async function _searchAccounts(company, q) {
  const like = '%' + _likeEscape(q) + '%';
  // Latest version per account_code: the accounts table is a slowly-changing
  // dimension (effective_from/effective_to). Pick the row with the greatest
  // effective_from per (company_id, account_code) via a ROW_NUMBER window.
  const rows = await query(
    `SELECT account_code, account_name
       FROM (
         SELECT account_code, account_name,
                ROW_NUMBER() OVER (
                  PARTITION BY company_id, account_code
                  ORDER BY effective_from DESC NULLS LAST
                ) AS rn
           FROM accounts
          WHERE company_id = @company
            AND is_active = true
       ) t
      WHERE rn = 1
        AND (account_name ILIKE @like ESCAPE '\\' OR account_code ILIKE @like ESCAPE '\\')
      ORDER BY account_code
      LIMIT ${PER_SCOPE_CAP}`,
    { company, like }
  );
  return rows.map(function (r) {
    return {
      type: 'account',
      id: r.account_code,
      label: r.account_code + ' ' + r.account_name,
      route: '/master-data?tab=coa'
    };
  });
}

async function _searchJournals(company, q) {
  const like = '%' + _likeEscape(q) + '%';
  // Multiple entries share a batch_id; DISTINCT collapses to one row per
  // (batch_id, reference). reference is the plain NNNNN form post-#195.
  const rows = await query(
    `SELECT DISTINCT batch_id, reference
       FROM journal_entries
      WHERE company_id = @company
        AND reference ILIKE @like ESCAPE '\\'
      ORDER BY reference
      LIMIT ${PER_SCOPE_CAP}`,
    { company, like }
  );
  return rows.map(function (r) {
    return {
      type: 'journal',
      id: r.batch_id,
      label: r.reference || r.batch_id,
      route: '/journal/voucher?batch=' + encodeURIComponent(r.batch_id)
    };
  });
}

async function _searchBills(company, q, scope) {
  const like = '%' + _likeEscape(q) + '%';
  // /b: scope excludes voided (and fully-paid) bills; /all includes every
  // status so a historical search can still surface a voided invoice.
  let statusFilter = '';
  if (scope === 'bill') {
    statusFilter = " AND status NOT IN ('voided', 'paid')";
  }
  const rows = await query(
    `SELECT bill_id, partner_name, vendor_ref
       FROM bills
      WHERE company_id = @company
        AND (partner_name ILIKE @like ESCAPE '\\' OR vendor_ref ILIKE @like ESCAPE '\\')
        ${statusFilter}
      ORDER BY date DESC, partner_name
      LIMIT ${PER_SCOPE_CAP}`,
    { company, like }
  );
  return rows.map(function (r) {
    return {
      type: 'bill',
      id: r.bill_id,
      label: r.partner_name + (r.vendor_ref ? ' ' + r.vendor_ref : ''),
      route: '/bill/' + encodeURIComponent(r.bill_id)
    };
  });
}

/**
 * Express handler: GET /api/:company/search?q=...&scope=...
 */
async function handleSearch(req, res) {
  try {
    const company = req.params.company;
    const q = (req.query.q || '').trim();
    let scope = (req.query.scope || 'all').trim().toLowerCase();

    if (!q) return res.json({ ok: true, results: [] });
    if (!VALID_SCOPES.has(scope)) scope = 'all';

    const wantAll = scope === 'all';
    let results = [];

    // Each scope runs in its own try/catch so a single failing scope
    // (e.g. a stale column name) doesn't kill the entire search —
    // the other scopes still return their results.
    async function _safe(label, fn) {
      try { return await fn(); }
      catch (err) { console.error('search error (' + label + '):', err); return []; }
    }

    if (wantAll || scope === 'partner') results = results.concat(await _safe('partner', () => _searchPartners(company, q)));
    if (wantAll || scope === 'account')  results = results.concat(await _safe('account',  () => _searchAccounts(company, q)));
    if (wantAll || scope === 'journal')  results = results.concat(await _safe('journal',  () => _searchJournals(company, q)));
    if (wantAll || scope === 'bill')     results = results.concat(await _safe('bill',     () => _searchBills(company, q, scope)));

    // Total cap (each scope already capped at PER_SCOPE_CAP).
    if (results.length > TOTAL_CAP) results = results.slice(0, TOTAL_CAP);

    res.json({ ok: true, results: results });
  } catch (err) {
    console.error('search error:', err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: String(err.message || err) } });
  }
}

module.exports = { handleSearch };
