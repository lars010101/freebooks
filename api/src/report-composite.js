'use strict';

// ── Annual-report composite (docs/jurisdiction-pack.md §4) ──────────────────
// Renders the jurisdiction pack's filings/annual-report.json descriptor into a
// print-ready statutory report (resultaträkning + balansräkning + noter for
// K2/SE; SFRS statements for SG) with prior-year comparatives. Descriptor is
// data; this file is the one generic renderer.

const fs = require('fs');
const path = require('path');

const JURISDICTIONS_DIR = path.join(__dirname, '..', '..', 'db', 'jurisdictions');

function loadPack(jurisdiction) {
  const dir = path.join(JURISDICTIONS_DIR, jurisdiction || 'SE');
  const manifestPath = path.join(dir, 'jurisdiction.json');
  const arPath = path.join(dir, 'filings', 'annual-report.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
  const descriptor = fs.existsSync(arPath) ? JSON.parse(fs.readFileSync(arPath, 'utf8')) : null;
  return { manifest, descriptor };
}

function shiftYear(d, delta) {
  const [y, m, day] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y + delta, m - 1, day));
  return dt.toISOString().slice(0, 10);
}

function fmtAmount(locale) {
  // Statutory reports are presented in whole kronor (matches the filed Bolagsverket
  // layout: "Alla belopp redovisas i hela kronor"). Negatives with a leading minus sign.
  const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  return (v) => {
    if (v == null || v === '') return '';
    const r0 = Math.round(v);
    return nf.format(r0 === 0 ? 0 : r0);
  };
}

async function renderAnnualReport(query, companyId, start, end, opts = {}) {
  const companies = await query(
    `SELECT company_name, jurisdiction, currency, reporting_standard, tax_id FROM companies WHERE company_id = ? LIMIT 1`,
    [companyId]
  );
  if (!companies.length) throw Object.assign(new Error('Company not found'), { code: 'NOT_FOUND' });
  const company = companies[0];

  const { manifest, descriptor } = loadPack(company.jurisdiction);
  if (!descriptor) throw Object.assign(new Error(`No annual-report descriptor for jurisdiction '${company.jurisdiction}'`), { code: 'NOT_FOUND' });

  const warnings = [];
  let variantKey = company.reporting_standard;
  let variant = descriptor.variants[variantKey];
  if (!variant) {
    variantKey = Object.keys(descriptor.variants)[0];
    variant = descriptor.variants[variantKey];
    warnings.push(`Reporting standard '${company.reporting_standard}' has no variant in ${company.jurisdiction}/annual-report.json — using '${variantKey}'.`);
  }

  // Per-year governance/tax facts: period.tax_attrs overrides descriptor facts.
  let periodAttrs = {};
  try {
    const prows = await query(
      `SELECT tax_attrs FROM periods WHERE company_id = ? AND start_date <= ? AND end_date >= ? ORDER BY start_date DESC LIMIT 1`,
      [companyId, start, end]
    );
    if (prows.length && prows[0].tax_attrs) periodAttrs = JSON.parse(prows[0].tax_attrs);
 } catch { /* tax_attrs column pre-migration */ }

  const priorStart = shiftYear(start, -1);
  const priorEnd = shiftYear(end, -1);
  const periods = [
    { label: end.slice(0, 4), start, end },
    { label: priorEnd.slice(0, 4), start: priorStart, end: priorEnd },
  ];

  // Per-account figures: balance at each period end (bs) + movement within each
  // period (pl), keyed by account code and by subtype.
  const acctRows = await query(
    `SELECT account_code, account_name, account_type, COALESCE(account_subtype, account_type) AS section
     FROM accounts WHERE company_id = ? AND is_active = true`,
    [companyId]
  );
  const subtypeOf = {};
  for (const a of acctRows) subtypeOf[a.account_code] = a.section;

  // Balance at period end + movement within the period, derived from two
  // balance snapshots (at start−1day and at end) — one scan per snapshot.
  async function sumsCorrect(p) {
    const bal = async (upto) => {
      const rows = await query(
        `SELECT account_code, SUM(debit_home) AS dr, SUM(credit_home) AS cr
         FROM journal_entries WHERE company_id = ? AND date <= ?
         GROUP BY account_code`,
        [companyId, upto]
      );
      const m = {};
      for (const r of rows) m[r.account_code] = { dr: Number(r.dr) || 0, cr: Number(r.cr) || 0 };
      return m;
    };
    const d = new Date(Date.UTC(Number(p.start.slice(0, 4)), Number(p.start.slice(5, 7)) - 1, Number(p.start.slice(8, 10)) - 1));
    const startMinus1 = d.toISOString().slice(0, 10);
    const [atEnd, atStartMinus1] = [await bal(p.end), await bal(startMinus1)];
    const codes = new Set([...Object.keys(atEnd), ...Object.keys(atStartMinus1)]);
    const byCode = {};
    for (const c of codes) {
      const e = atEnd[c] || { dr: 0, cr: 0 };
      const s = atStartMinus1[c] || { dr: 0, cr: 0 };
      byCode[c] = {
        balance: { dr: e.dr, cr: e.cr },
        movement: { dr: e.dr - s.dr, cr: e.cr - s.cr },
      };
    }
    return byCode;
  }

  const perPeriod = [];
  for (const p of periods) perPeriod.push(await sumsCorrect(p));

  function lineValue(line, colIdx, kind) {
    if (line.sum) return 0; // computed after sources
    const byCode = perPeriod[colIdx];
    let total = 0;
    const codes = line.accounts
      ? line.accounts
      : acctRows.filter((a) => (line.subtypes || []).includes(subtypeOf[a.account_code])).map((a) => a.account_code);
    for (const code of codes) {
      const cell = byCode[code];
      if (!cell) continue;
      if (kind === 'bs') {
        total += line.side === 'asset' ? cell.balance.dr - cell.balance.cr : cell.balance.cr - cell.balance.dr;
      } else {
        if (line.side === 'income') total += cell.movement.cr - cell.movement.dr;
        else total += -(cell.movement.dr - cell.movement.cr); // expense shown negative
      }
    }
    return total;
  }

  const locale = (company.jurisdiction || '').toUpperCase() === 'SE' ? 'sv-SE' : 'en-SG';
  const fmt = fmtAmount(locale);
  const nf0 = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });

  const statements = [];
  for (const st of variant.statements) {
    const values = {}; // lineId -> [col0, col1]
    const rows = [];
    for (const line of st.lines) {
      let cols;
      if (line.sum) {
        cols = periods.map((_, ci) => line.sum.reduce((acc, id) => acc + (values[id] ? values[id][ci] : 0), 0));
      } else {
        cols = periods.map((_, ci) => lineValue(line, ci, st.kind));
      }
      values[line.id] = cols;
      const allZero = cols.every((v) => Math.abs(v) < 0.005);
      if (allZero && !line.keep && !line.sum) continue;
      rows.push({ id: line.id, label: line.label, bold: !!line.bold, cols });
    }
    statements.push({ id: st.id, title: st.title, kind: st.kind, rows });
  }

  // Balance assertion on the bs statement (summa tillgångar == summa EK+skulder per column).
  const bs = statements.find((s) => s.kind === 'bs');
  if (bs) {
    const assets = bs.rows.find((r) => r.id === 'summa_tillgangar' || /total_assets/.test(r.id));
    const eqLiab = bs.rows.find((r) => r.id === 'summa_ek_skulder' || /total_eq_liab/.test(r.id));
    if (assets && eqLiab) {
      assets.cols.forEach((v, i) => {
        if (Math.abs(v - eqLiab.cols[i]) > 0.005) {
          warnings.push(`Balance check failed ${periods[i].label}: assets ${v.toFixed(2)} ≠ equity+liabilities ${eqLiab.cols[i].toFixed(2)}`);
        }
      });
    }
  }

  // RR vs BS consistency: the RR column is movement-based; if a prior year's result was
  // inherited via opening balances (no rev/exp entries that year), the RR comparative shows 0
  // while the BS Årets resultat line shows the inherited amount. Flag rather than fabricate.
  const rr0 = statements.find((s) => s.kind === 'pl');
  const rrRes = rr0 && rr0.rows.find((r) => r.id === 'arets_resultat' || r.id === 'profit_for_year');
  const bsAr = bs && bs.rows.find((r) => r.id === 'arets_resultat_br');
  if (rrRes && bsAr) {
    rrRes.cols.forEach((v, i) => {
      const bsV = bsAr.cols[i] || 0;
      if (Math.abs(v - bsV) > 0.005) {
        warnings.push(`${periods[i].label}: resultaträkningen visar ${v.toFixed(2)} men balansräkningens årets resultat är ${bsV.toFixed(2)} — det jämförelseårets resultat förvärvades via ingångsvärden och rörelsens konton saknar bokförda poster det året.`);
      }
    });
  }

  // Notes templating. Facts = descriptor variant.facts overridden by period.tax_attrs.
  const facts = Object.assign({}, variant.facts || {}, periodAttrs);
  const equityLine = bs && bs.rows.find((r) => r.id === 'aktiekapital' || r.id === 'share_capital');
  const shareCapital = equityLine ? equityLine.cols[0] : 0;
  const rr = statements.find((s) => s.kind === 'pl');
  const rrResult = rr && rr.rows.find((r) => r.id === 'arets_resultat' || r.id === 'profit_for_year');
  const balLine = bs && bs.rows.find((r) => r.id === 'balanserat' || r.id === 'retained_earnings');
  const ekTotal = bs && bs.rows.find((r) => r.id === 'summa_ek' || r.id === 'total_equity');

  const baseMap = {
    company_name: company.company_name,
    org_nr: company.tax_id || '',
    period_start: start,
    period_end: end,
    standard: variantKey,
    currency: company.currency || (manifest && manifest.currency) || '',
    aktiekapital: nf0.format(shareCapital),
    rr_result: rrResult ? fmt(rrResult.cols[0]) : '',
    rr_result_abs: rrResult ? nf0.format(Math.abs(rrResult.cols[0])) : '',
    balanserat: balLine ? nf0.format(balLine.cols[0]) : '',
  };
  const fill = (tpl) => tpl.replace(/\{([a-z_0-9]+)\}/gi, (m, k) => {
    if (k in baseMap) return baseMap[k];
    if (facts[k] != null) return typeof facts[k] === 'number' ? nf0.format(facts[k]) : String(facts[k]);
    return m; // leave unknown placeholders visible — a warning sign, not silent data loss
  });

  // Computed note types.
  const computedNote = async (n) => {
    if (n.type === 'equity_reconciliation') {
      // Filed Bolagsverket movement table, ONE block per year-column. Rows are events,
      // not snapshots — amounts appear only in the columns the event touches, blanks
      // elsewhere (null → rendered blank). Row 5 must equal the vertical column sums.
      //
      //   1. Belopp vid årets ingång   = balances at period start−1: 2081, 2091+2098, 2099
      //   2. Utdelning                 = AGM dividend decided, traceable via 2898 (balanserat col, negative)
      //   3. Balanseras i ny räkning   = 1c − 2b (carried to balance sheet); 2099 cleared by the rebooking
      //   4. Årets resultat            = balance of 2099 at period end (the closing entry)
      //   5. Belopp vid årets utgång   = balances at period end: 2081, 2091+2098, 2099
      //
      // Note on sign convention: equity accounts are credit-normal; a dividend decision
      // is DR 2091 / CR 2898, so the 2091 movement within the period nets the dividend out
      // of the closing balance. We surface it explicitly from the 2898 credit turnover.
      const balAtQuery = async (upto, codes) => {
        const rows = await query(
          `SELECT account_code, SUM(debit_home) dr, SUM(credit_home) cr FROM journal_entries
           WHERE company_id = ? AND date <= ? AND account_code IN (${codes.map(() => '?').join(',')})
           GROUP BY account_code`, [companyId, upto, ...codes]);
        let t = 0;
        for (const r2 of rows) t += (Number(r2.cr) || 0) - (Number(r2.dr) || 0);
        return t;
      };
      const turnoverQuery = async (from, to, code) => {
        const rows = await query(
          `SELECT SUM(debit_home) dr, SUM(credit_home) cr FROM journal_entries
           WHERE company_id = ? AND date >= ? AND date <= ? AND account_code = ?`, [companyId, from, to, code]);
        const r2 = rows[0] || {};
        return { dr: Number(r2.dr) || 0, cr: Number(r2.cr) || 0 };
      };

      const heads = ['', 'Aktiekapital', 'Balanserat resultat', 'Årets resultat', 'Totalt'];
      const B = null; // blank cell
      const rows = [];
      // One block only — the current year. The filed format shows the equity movement
      // for the reporting year; prior-year detail lives in the comparative BS column.
      for (let ci = 0; ci < 1; ci++) {
        const p = periods[ci];
        const d0 = new Date(Date.UTC(Number(p.start.slice(0, 4)), Number(p.start.slice(5, 7)) - 1, Number(p.start.slice(8, 10)) - 1));
        const startM1 = d0.toISOString().slice(0, 10);
        // Row 1 — opening balances
        const openAk = await balAtQuery(startM1, ['2081']);
        const openBal = await balAtQuery(startM1, ['2091', '2098']);
        const openAr = await balAtQuery(startM1, ['2099']);
        // Row 2 — dividend: 2898 credit turnover within the year = dividend decided
        const div = await turnoverQuery(p.start, p.end, '2898');
        const dividend = div.cr - div.dr; // >0 means unpaid balance grew → decided dividend
        // Row 3 — balanseras: prior result carried over, less any dividend
        const carry = openAr - (dividend > 0 ? dividend : 0);
        // Row 4 — årets resultat: 2099 balance at year end (closing entry)
        const closeAr = await balAtQuery(p.end, ['2099']);
        // Row 5 — closing balances
        const closeAk = await balAtQuery(p.end, ['2081']);
        const closeBal = await balAtQuery(p.end, ['2091', '2098']);

        const tot = (a, b, c) => (a || 0) + (b || 0) + (c || 0);
        rows.push(['Belopp vid årets ingång', openAk, openBal, openAr, tot(openAk, openBal, openAr)]);
        // Utdelning is a permanent row — it records what the AGM actually decided this
        // year (0 when no dividend was decided, which is itself a decided happening).
        rows.push(['Utdelning', B, dividend > 0.005 ? -dividend : 0, B, dividend > 0.005 ? -dividend : 0]);
        if (Math.abs(openAr) > 0.005) {
          // AGM transfer: 1c less dividend goes to balanserat; the full 1c clears the
          // årets-resultat column (2099 rebooked). Row total = −dividend (0 without dividend),
          // and every column then sums vertically to row 5.
          rows.push(['Balanseras i ny räkning', B, carry, -openAr, carry - openAr]);
        }
        rows.push(['Årets resultat', B, B, closeAr, closeAr]);
        rows.push(['Belopp vid årets utgång', closeAk, closeBal, closeAr, tot(closeAk, closeBal, closeAr)]);
      }
      // Sanity: for each column block, utgång should equal the vertical sum of the event rows.
      // (Not asserted here — the renderer trusts the balances; discrepancies indicate booking
      // outside 2081/2091/2098/2099/2898, which the RR/BS warning path already surfaces.)
      return { title: n.title, table: { heads, rows }, hidden: !!n.hidden };
    }
    return { title: n.title, text: fill(n.template || ''), hidden: !!n.hidden };
  };

  const notes = [];
  for (const n of (variant.notes || [])) notes.push(await computedNote(n));

  // Förvaltningsberättelse (filed-format section order: verksamhet, flerårsöversikt,
  // förändring i eget kapital, resultatdisposition). Rendered before the statements.
  let fb = null;
  if (variant.fb) {
    const fbFacts = Object.assign({}, facts);
    const ff = (tpl) => tpl.replace(/\{([a-z_0-9]+)\}/gi, (m, k) => {
      if (k in baseMap) return baseMap[k];
      if (fbFacts[k] != null) return typeof fbFacts[k] === 'number' ? nf0.format(fbFacts[k]) : String(fbFacts[k]);
      return m;
    });
    // Flerårsöversikt in tkr: nettoomsättning, resultat efter finansiella poster, soliditet.
    // Filed reports show up to 3 years; periods[] only carries 2 columns, so query year−2 directly.
    const rrNet = rr0 && rr0.rows.find((r) => r.id === 'nettoomsattning');
    const rrFin = rr0 && rr0.rows.find((r) => r.id === 'res_efter_fin');
    const bsAssets = bs && bs.rows.find((r) => r.id === 'summa_tillgangar');
    const overview = periods.map((p, ci) => ({
      year: p.label,
      netto: rrNet ? (rrNet.cols[ci] || 0) / 1000 : 0,
      resFin: rrFin ? (rrFin.cols[ci] || 0) / 1000 : 0,
      soliditet: bsAssets && ekTotal && bsAssets.cols[ci] ? Math.round((ekTotal.cols[ci] / bsAssets.cols[ci]) * 100) : 0,
    }));
    // Third year (year−2): derived from balance snapshots at its start−1/end.
    try {
      const y2Start = shiftYear(start, -2);
      const y2End = shiftYear(end, -2);
      const d2 = new Date(Date.UTC(Number(y2Start.slice(0, 4)), Number(y2Start.slice(5, 7)) - 1, Number(y2Start.slice(8, 10)) - 1));
      const y2StartM1 = d2.toISOString().slice(0, 10);
      const balAt = async (upto) => {
        const rows = await query(
          `SELECT account_code, SUM(debit_home) dr, SUM(credit_home) cr FROM journal_entries
           WHERE company_id = ? AND date <= ? GROUP BY account_code`, [companyId, upto]);
        const m = {};
        for (const r2 of rows) m[r2.account_code] = (Number(r2.cr) || 0) - (Number(r2.dr) || 0);
        return m;
      };
      const [atEnd2, atStart2] = [await balAt(y2End), await balAt(y2StartM1)];
      // netto + resFin from movement of income/expense accounts
      const mov = (code) => (atEnd2[code] || 0) - (atStart2[code] || 0);
      let netto2 = 0, fin2 = 0, ek2 = 0, assets2 = 0;
      for (const a of acctRows) {
        const sec = subtypeOf[a.account_code] || '';
        const m = mov(a.account_code);
        if (sec === 'Revenue' || sec === 'Other Income') netto2 += m;
        if (sec === 'Revenue' || sec === 'Other Income' || sec === 'Operating Expenses' || sec === 'Personnel Costs' || sec === 'Depreciation' || sec === 'Financial Items') fin2 += m;
        const e = atEnd2[a.account_code] || 0;
        if (a.account_code >= '2000' && a.account_code < '3000') ek2 += e;
        if (a.account_code >= '1000' && a.account_code < '2000') assets2 -= e; // debit-balance: cr−dr is negative
      }
      overview.push({ year: y2End.slice(0, 4), netto: netto2 / 1000, resFin: fin2 / 1000, soliditet: assets2 ? Math.round((ek2 / assets2) * 100) : 0, hasData: Object.keys(atEnd2).length > 0 });
    } catch { /* year−2 unavailable — two-year overview */ }
    // Resultatdisposition: balanserat + årets resultat → proposed split.
    // proposed_dividend (user input via facts/tax_attrs) is decided at NEXT year's AGM;
    // it reduces Balanseras i ny räkning while Totalt stays fixed at the available amount.
    const disp = {
      balanserat: balLine ? balLine.cols[0] : 0,
      arets: bsAr ? bsAr.cols[0] : 0,
    };
    disp.total = disp.balanserat + disp.arets;
    disp.utdelning = Number(fbFacts.proposed_dividend) || 0;
    disp.balanseras = disp.total - disp.utdelning;
    // Equity reconciliation reuses the computed note if present.
    const eqNote = notes.find((n) => n.table);
    fb = {
      verksamhet: ff(variant.fb.verksamhet || ''),
      handelser: variant.fb.handelser ? ff(variant.fb.handelser) : null,
      overview,
      equityTable: eqNote ? eqNote.table : null,
      disposition: disp,
      trailing: variant.fb.trailing ? ff(variant.fb.trailing) : null,
    };
  }

  // Signature block: one entry per board member. facts.board_members may be
  // [{name, role}] objects (filed format: name + role per line); falls back to
  // plain names from facts.board_names. facts.ort provides the place line.
  let signatureBlock = variant.signatureBlock || '';
  const members = Array.isArray(facts.board_members) && facts.board_members.length
    ? facts.board_members
    : (Array.isArray(facts.board_names) ? facts.board_names.map((nm) => ({ name: nm, role: '' })) : []);
  if (members.length) {
    const ort = facts.ort ? `${facts.ort}` : 'Ort och datum: ______________';
    const sigs = members.map((m) => {
      const name = typeof m === 'string' ? m : m.name;
      const role = typeof m === 'object' && m.role ? `\n${m.role}` : '';
      return `_____________________\n${name}${role}`;
    }).join('\n\n');
    signatureBlock = `Årsredovisningen är undertecknad av samtliga styrelseledamöter.\n\n${ort}\n\n${sigs}\n\nÅrsredovisningen fastställdes på årsstämman den ______________`;
  }

  const result = { company, manifest, descriptor, variantKey, periods, statements, notes, fb, signatureBlock, warnings };

  if (opts.format === 'json') return result;
  return { html: renderHtml(result, fmt), csv: renderCsv(result), filename: `annual-report_${companyId}_${end.slice(0, 4)}` };
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderHtml(r, fmt) {
  const nf0sv = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 });
  const tkr = (v) => { const r0 = Math.round(v); return nf0sv.format(r0 === 0 ? 0 : r0); };
  const colHeads = r.periods.map((p) => `<th class="num">${esc(p.label)}</th>`).join('');
  const stmtHtml = r.statements.map((st) => {
    const rows = st.rows.map((row) => {
      const tds = row.cols.map((v) => `<td class="num">${fmt(v)}</td>`).join('');
      return `<tr class="${row.bold ? 'bold' : ''}"><td>${esc(row.label)}</td>${tds}</tr>`;
    }).join('\n');
    return `<h2>${esc(st.title)}</h2>\n<table><thead><tr><th></th>${colHeads}</tr></thead><tbody>${rows}</tbody></table>`;
  }).join('\n');
  const notesHtml = r.notes.filter((n) => !n.hidden).map((n) => {
    if (n.table) {
      const heads = n.table.heads.map((h) => `<th class="num">${esc(h)}</th>`).join('');
      const rows = n.table.rows.map((row) => `<tr><td>${esc(row[0])}</td>${row.slice(1).map((v) => `<td class="num">${fmt(v)}</td>`).join('')}</tr>`).join('');
      return `<h3>${esc(n.title)}</h3><table><thead><tr>${heads}</tr></thead><tbody>${rows}</tbody></table>`;
    }
    return `<h3>${esc(n.title)}</h3><p>${esc(n.text)}</p>`;
  }).join('\n');

  let fbHtml = '';
  if (r.fb) {
    const f = r.fb;
    const ovRows = f.overview.filter((o) => o.hasData !== false).map((o) => `<tr><td class="num">${esc(o.year)}</td><td class="num">${tkr(o.netto)}</td><td class="num">${tkr(o.resFin)}</td><td class="num">${o.soliditet}</td></tr>`).join('');
    let eqHtml = '';
    if (f.equityTable) {
      const heads = f.equityTable.heads.map((h) => `<th class="num">${esc(h)}</th>`).join('');
      const rows = f.equityTable.rows.map((row) => `<tr><td>${esc(row[0])}</td>${row.slice(1).map((v) => `<td class="num">${fmt(v)}</td>`).join('')}</tr>`).join('');
      eqHtml = `<h3>Förändringar i eget kapital</h3><table><thead><tr>${heads}</tr></thead><tbody>${rows}</tbody></table>`;
    }
    const d = f.disposition;
    fbHtml = `<h2>Förvaltningsberättelse</h2>
<h3>Verksamheten</h3>
<p>${esc(f.verksamhet)}</p>
${f.handelser ? `<h3>Väsentliga händelser under räkenskapsåret</h3>\n<p>${esc(f.handelser)}</p>` : ''}
<h3>Flerårsöversikt (tkr)</h3>
<table><thead><tr><th></th><th class="num">Nettoomsättning</th><th class="num">Resultat efter finansiella poster</th><th class="num">Soliditet (%)</th></tr></thead><tbody>${ovRows}</tbody></table>
${eqHtml}
<h3>Resultatdisposition</h3>
<p>Till årsstämmans förfogande står följande vinstmedel:</p>
<table><tbody>
<tr><td>Balanserat resultat</td><td class="num">${fmt(d.balanserat)}</td></tr>
<tr><td>Årets resultat</td><td class="num">${fmt(d.arets)}</td></tr>
<tr class="bold"><td>Totalt</td><td class="num">${fmt(d.total)}</td></tr>
</tbody></table>
<p>Styrelsen föreslår att vinstmedlen disponeras enligt följande:</p>
<table><tbody>
<tr><td>Utdelning</td><td class="num">${fmt(d.utdelning)}</td></tr>
<tr><td>Balanseras i ny räkning</td><td class="num">${fmt(d.balanseras)}</td></tr>
<tr class="bold"><td>Totalt</td><td class="num">${fmt(d.total)}</td></tr>
</tbody></table>
${f.trailing ? `<p>${esc(f.trailing)}</p>` : '<p>Företagets resultat och ställning i övrigt framgår av efterföljande resultat- och balansräkning med noter.</p>'}`;
  }

  const warn = r.warnings.length ? `<div class="warn">${r.warnings.map(esc).join('<br>')}</div>` : '';
  const sig = r.signatureBlock ? `<div class="sig">${esc(r.signatureBlock).replace(/\n/g, '<br>')}</div>` : '';

  return `<!DOCTYPE html>
<html lang="sv"><head><meta charset="utf-8"><title>${esc(r.descriptor.name)} — ${esc(r.company.company_name)}</title>
<style>
  :root { --text:#1a1a1a; --muted:#666; --border:#ccc; --accent:#1f3a5f; }
  body { font: 0.95rem/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; color:var(--text); max-width: 52rem; margin: 2rem auto; padding: 0 1.5rem; }
  .toolbar { background:#fff8e6; border:1px solid #e6d9a8; padding:.5rem .75rem; border-radius:6px; margin-bottom:1.5rem; font-size:.85rem; color:#6b5d2a; }
  h1 { font-size:1.4rem; margin:.2rem 0; } h2 { font-size:1.1rem; margin:1.6rem 0 .4rem; color:var(--accent); border-bottom:2px solid var(--accent); padding-bottom:.15rem; }
  h3 { font-size:1rem; margin:1.2rem 0 .2rem; }
  .meta { color:var(--muted); margin-bottom:1rem; }
  table { width:100%; border-collapse:collapse; margin-bottom:.5rem; }
  th, td { padding:.18rem .4rem; text-align:left; }
  th.num, td.num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  thead th { border-bottom:1px solid var(--border); font-size:.85rem; color:var(--muted); }
  tr.bold td { font-weight:700; border-top:1px solid var(--border); }
  .warn { background:#fdecea; border:1px solid #f5c6c0; color:#8a2010; padding:.5rem .75rem; border-radius:6px; margin:1rem 0; }
  .sig { margin-top:3rem; white-space:normal; line-height:2.2; }
  @media print { .toolbar { display:none; } body { margin:0; max-width:none; } }
</style></head><body>
<div class="toolbar">Skriv ut / Spara som PDF (Ctrl+P) — detta dokument är avsett att skrivas ut.</div>
<h1>${esc(r.descriptor.name)}</h1>
<div class="meta">${esc(r.company.company_name)}${r.company.tax_id ? ' · ' + esc(r.company.tax_id) : ''} · Räkenskapsår ${esc(r.periods[0].start)} – ${esc(r.periods[0].end)} · ${esc(r.variantKey)}</div>
${warn}
${fbHtml}
${stmtHtml}
<h2>Noter</h2>
${notesHtml}
${sig}
</body></html>`;
}

function renderCsv(r) {
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const lines = [q('Section') + ',' + q('Line') + ',' + r.periods.map((p) => q(p.label)).join(',')];
  for (const st of r.statements) {
    for (const row of st.rows) {
      lines.push(q(st.title) + ',' + q(row.label) + ',' + row.cols.map((v) => v.toFixed(2)).join(','));
    }
  }
  return lines.join('\n') + '\n';
}

module.exports = { renderAnnualReport };
