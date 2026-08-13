// tests/search.test.mjs — global search endpoint (command-bar-ux-spec §4).
//
// Boots a throwaway in-process freeBooks server, seeds a company + entities
// (partner, account, journal batch, bill) via the action API + admin SQL
// endpoint, and exercises GET /api/:company/search across every scope.
//
// Run:  node tests/search.test.mjs
// Exits non-zero on any failure.

import { startServer, apiPost } from './lib/test-server.mjs';

const CO = 'srchco';
let BASE = '';
let ADMIN = '';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗ FAIL:', name, detail ? `— ${detail}` : ''); }
}
function eq(name, actual, expected) {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  ok(name, match, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── helpers ─────────────────────────────────────────────────────────────────
async function sql(query, params = []) {
  const r = await fetch(`${BASE}/api/admin/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN}` },
    body: JSON.stringify({ sql: query, params }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`admin query failed ${r.status}: ${JSON.stringify(body)}`);
  return body.rows || [];
}

async function search(q, scope) {
  const url = `${BASE}/api/${CO}/search?q=${encodeURIComponent(q)}${scope ? `&scope=${encodeURIComponent(scope)}` : ''}`;
  const r = await fetch(url);
  const body = await r.json();
  if (!r.ok) throw new Error(`search ${q}/${scope} -> ${r.status}: ${JSON.stringify(body)}`);
  return body;
}

// ── seed ─────────────────────────────────────────────────────────────────────
async function seed() {
  // Company + SE BAS COA (gives us real accounts + an open period).
  await apiPost(BASE, 'setup.add_company', 'x', {
    company: {
      company_id: CO, company_name: 'Search Co', jurisdiction: 'SE',
      currency: 'SEK', reporting_standard: 'K2', vat_registered: false,
      fy_start: '2026-01-01', fy_end: '2026-12-31',
    },
  }, 'srch-setup').catch((e) => {
    if (!/already exists|DUPLICATE/.test(String(e.message))) throw e;
  });

  // A distinctive partner (the SE template does not add partners).
  await sql(
    `INSERT INTO partners (partner_id, company_id, name, is_active, is_vendor, is_customer)
     VALUES (?, ?, ?, true, true, false)`,
    ['p-srch-1', CO, 'Acme Supplies AB']
  );
  // An inactive partner — must NOT surface in search.
  await sql(
    `INSERT INTO partners (partner_id, company_id, name, is_active, is_vendor, is_customer)
     VALUES (?, ?, ?, false, true, false)`,
    ['p-srch-2', CO, 'Ghost Partner Inc']
  );

  // A distinctive account (SE template has standard codes; add a uniquely
  // named one so the match is deterministic).
  await sql(
    `INSERT INTO accounts (company_id, account_code, account_name, account_type, is_active, effective_from)
     VALUES (?, ?, ?, ?, true, DATE '2026-01-01')`,
    [CO, '1999', 'Acme Cash Account', 'Asset']
  );

  // A journal batch with a plain NNNNN reference (post-#195 format).
  await sql(
    `INSERT INTO journal_entries
       (company_id, entry_id, batch_id, date, account_code, debit, credit, currency, source, reference)
     VALUES (?, ?, ?, DATE '2026-02-15', '1999', 100, 0, 'SEK', 'manual', '00001')`,
    [CO, 'je-srch-1', 'batch-srch-1']
  );
  await sql(
    `INSERT INTO journal_entries
       (company_id, entry_id, batch_id, date, account_code, debit, credit, currency, source, reference)
     VALUES (?, ?, ?, DATE '2026-02-15', '1999', 0, 100, 'SEK', 'manual', '00001')`,
    [CO, 'je-srch-2', 'batch-srch-1']
  );

  // A bill for Acme with a vendor_ref.
  await sql(
    `INSERT INTO bills
       (company_id, bill_id, partner_name, vendor_ref, date, due_date, amount,
        currency, fx_rate, amount_home, expense_account, ap_account, status)
     VALUES (?, ?, ?, ?, DATE '2026-03-01', DATE '2026-03-31', 500,
        'SEK', 1.0, 500, '1999', '2440', 'draft')`,
    [CO, 'bill-srch-1', 'Acme Supplies AB', 'INV-1001']
  );
  // A voided bill — must NOT surface under /b: scope, but SHOULD under /all.
  await sql(
    `INSERT INTO bills
       (company_id, bill_id, partner_name, vendor_ref, date, due_date, amount,
        currency, fx_rate, amount_home, expense_account, ap_account, status)
     VALUES (?, ?, ?, ?, DATE '2026-03-02', DATE '2026-04-01', 300,
        'SEK', 1.0, 300, '1999', '2440', 'voided')`,
    [CO, 'bill-srch-2', 'Voided Vendor Ltd', 'INV-Void']
  );
}

async function main() {
  const srv = await startServer();
  BASE = srv.baseUrl;
  ADMIN = srv.adminToken;
  try {
    await seed();

    // ── 1. partner scope ────────────────────────────────────────────────────
    {
      const r = await search('Acme', 'partner');
      eq('partner scope ok', r.ok, true);
      ok('partner scope finds Acme partner',
        r.results.some((x) => x.type === 'partner' && x.label === 'Acme Supplies AB'),
        JSON.stringify(r.results));
      ok('partner result route is master-data partners',
        r.results.some((x) => x.route === '/master-data?tab=partners'));
      ok('partner scope excludes inactive partner',
        !r.results.some((x) => x.label === 'Ghost Partner Inc'));
      // Only partners should be returned under scope=partner.
      ok('partner scope returns only partner types',
        r.results.every((x) => x.type === 'partner'));
    }

    // ── 2. account scope ─────────────────────────────────────────────────────
    {
      const byName = await search('Acme Cash', 'account');
      ok('account scope finds by account_name',
        byName.results.some((x) => x.type === 'account' && x.id === '1999'),
        JSON.stringify(byName.results));
      ok('account label is code + name',
        byName.results.some((x) => x.label === '1999 Acme Cash Account'));
      ok('account route is coa tab',
        byName.results.some((x) => x.route === '/master-data?tab=coa'));

      const byCode = await search('199', 'account');
      ok('account scope finds by account_code',
        byCode.results.some((x) => x.type === 'account' && x.id === '1999'));
      ok('account scope returns only account types',
        byCode.results.every((x) => x.type === 'account'));
    }

    // ── 3. journal scope ─────────────────────────────────────────────────────
    {
      const r = await search('00001', 'journal');
      ok('journal scope finds reference 00001',
        r.results.some((x) => x.type === 'journal' && x.id === 'batch-srch-1'),
        JSON.stringify(r.results));
      ok('journal label is the reference',
        r.results.some((x) => x.label === '00001'));
      ok('journal route targets the batch',
        r.results.some((x) => x.route === '/journal/voucher?batch=batch-srch-1'));
      // Distinct on batch_id: two entries share batch-srch-1 → one row.
      ok('journal scope dedupes by batch_id',
        r.results.filter((x) => x.id === 'batch-srch-1').length === 1);
    }

    // ── 4. bill scope ─────────────────────────────────────────────────────────
    {
      const r = await search('Acme', 'bill');
      ok('bill scope finds Acme bill',
        r.results.some((x) => x.type === 'bill' && x.id === 'bill-srch-1'),
        JSON.stringify(r.results));
      ok('bill label includes vendor_ref',
        r.results.some((x) => x.label === 'Acme Supplies AB INV-1001'));
      ok('bill route targets bill detail',
        r.results.some((x) => x.route === '/bill/bill-srch-1'));
      // /b: scope excludes voided bills.
      ok('bill scope excludes voided bill',
        !r.results.some((x) => x.id === 'bill-srch-2'));

      // Search by vendor_ref.
      const byRef = await search('INV-1001', 'bill');
      ok('bill scope finds by vendor_ref',
        byRef.results.some((x) => x.id === 'bill-srch-1'));
    }

    // ── 5. all scope ──────────────────────────────────────────────────────────
    {
      const r = await search('Acme', 'all');
      ok('all scope returns partner result',
        r.results.some((x) => x.type === 'partner'));
      ok('all scope returns account result',
        r.results.some((x) => x.type === 'account' && x.id === '1999'));
      ok('all scope returns bill result',
        r.results.some((x) => x.type === 'bill' && x.id === 'bill-srch-1'));

      // /all includes voided bills (historical search), while /b: excludes them.
      const rVoid = await search('Voided', 'all');
      ok('all scope includes voided bill',
        rVoid.results.some((x) => x.id === 'bill-srch-2'),
        'voided bill should surface under /all');
      const bVoid = await search('Voided', 'bill');
      ok('bill scope excludes voided bill (by name)',
        !bVoid.results.some((x) => x.id === 'bill-srch-2'));
    }

    // ── 6. empty query ─────────────────────────────────────────────────────────
    {
      const r = await search('', 'all');
      eq('empty query returns ok', r.ok, true);
      eq('empty query returns no results', r.results, []);
    }

    // ── 7. no results ──────────────────────────────────────────────────────────
    {
      const r = await search('zzzznomatch', 'all');
      eq('no-match query returns ok', r.ok, true);
      eq('no-match query returns empty', r.results, []);
    }

    // ── 8. default scope (omitted) behaves as 'all' ────────────────────────────
    {
      const r = await search('Acme');
      ok('omitted scope defaults to all (finds partner)',
        r.results.some((x) => x.type === 'partner'));
    }

    // ── 9. invalid scope falls back to all ──────────────────────────────────────
    {
      const r = await search('Acme', 'bogus');
      ok('invalid scope falls back to all',
        r.results.some((x) => x.type === 'partner'));
    }

    // ── 10. per-scope cap (10) ─────────────────────────────────────────────────
    {
      // Seed 12 partners matching "CapTest" to verify the cap.
      for (let i = 0; i < 12; i++) {
        await sql(
          `INSERT INTO partners (partner_id, company_id, name, is_active, is_vendor, is_customer)
           VALUES (?, ?, ?, true, true, false)`,
          [`p-cap-${i}`, CO, `CapTest Partner ${i}`]
        );
      }
      const r = await search('CapTest', 'partner');
      ok('partner scope capped at 10', r.results.length === 10, `got ${r.results.length}`);
    }
  } finally {
    await srv.cleanup();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
