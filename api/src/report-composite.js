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
  const nf = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (v) => (v < 0 ? `(${nf.format(Math.abs(v))})` : nf.format(v));
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

  // Notes templating.
  const equityLine = bs && bs.rows.find((r) => r.id === 'aktiekapital' || r.id === 'share_capital');
  const shareCapital = equityLine ? equityLine.cols[0] : 0;
  const fill = (tpl) => tpl
    .replaceAll('{company_name}', company.company_name)
    .replaceAll('{org_nr}', company.tax_id || '')
    .replaceAll('{period_start}', start)
    .replaceAll('{period_end}', end)
    .replaceAll('{standard}', variantKey)
    .replaceAll('{currency}', company.currency || (manifest && manifest.currency) || '')
    .replaceAll('{aktiekapital}', nf0.format(shareCapital));

  const result = { company, manifest, descriptor, variantKey, periods, statements, notes: (variant.notes || []).map((n) => ({ title: n.title, text: fill(n.template) })), signatureBlock: variant.signatureBlock || '', warnings };

  if (opts.format === 'json') return result;
  return { html: renderHtml(result, fmt), csv: renderCsv(result), filename: `annual-report_${companyId}_${end.slice(0, 4)}` };
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderHtml(r, fmt) {
  const colHeads = r.periods.map((p) => `<th class="num">${esc(p.label)}</th>`).join('');
  const stmtHtml = r.statements.map((st) => {
    const rows = st.rows.map((row) => {
      const tds = row.cols.map((v) => `<td class="num">${fmt(v)}</td>`).join('');
      return `<tr class="${row.bold ? 'bold' : ''}"><td>${esc(row.label)}</td>${tds}</tr>`;
    }).join('\n');
    return `<h2>${esc(st.title)}</h2>\n<table><thead><tr><th></th>${colHeads}</tr></thead><tbody>${rows}</tbody></table>`;
  }).join('\n');
  const notesHtml = r.notes.map((n) => `<h3>${esc(n.title)}</h3><p>${esc(n.text)}</p>`).join('\n');
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
