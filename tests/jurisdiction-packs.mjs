#!/usr/bin/env node
'use strict';

// Pack linter (docs/jurisdiction-pack.md §6): validates every jurisdiction pack
// under db/jurisdictions/. Exit 1 on any failure, naming the file and key.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'jurisdictions');
let failures = 0;
const fail = (pack, msg) => { failures++; console.error(`FAIL [${pack}] ${msg}`); };

for (const entry of fs.readdirSync(DIR, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith('_')) continue; // _-prefixed = contributor scaffolds, not live packs
  const code = entry.name;
  const dir = path.join(DIR, code);

  // manifest
  const mPath = path.join(dir, 'jurisdiction.json');
  let manifest = null;
  if (!fs.existsSync(mPath)) fail(code, 'missing jurisdiction.json');
  else {
    try { manifest = JSON.parse(fs.readFileSync(mPath, 'utf8')); }
    catch (e) { fail(code, `jurisdiction.json does not parse: ${e.message}`); }
  }
  if (manifest) {
    if (manifest.schema !== 1) fail(code, `jurisdiction.json schema must be 1 (got ${manifest.schema})`);
    if (manifest.code !== code) fail(code, `manifest code '${manifest.code}' != directory '${code}'`);
    if (!Array.isArray(manifest.reportingStandards) || manifest.reportingStandards.length === 0)
      fail(code, 'reportingStandards must be a non-empty array');
    const keys = (manifest.taxAttributes || []).map((a) => a.key);
    if (new Set(keys).size !== keys.length) fail(code, 'duplicate taxAttributes keys');

    // closeChecklist (IA-spec step 4, §5.10): validated closed op vocabulary so a
    // typo'd op can't silently neuter a close-check item. Allowed ops:
    //   vat_return_done | contact_attrs_complete | tax_attr_set | manual
    // tax_attr_set requires a sibling `attr` naming a declared taxAttribute.
    const CLOSE_OPS = new Set(['vat_return_done', 'contact_attrs_complete', 'tax_attr_set', 'manual']);
    const taxAttrKeys = new Set((manifest.taxAttributes || []).map((a) => a.key));
    for (const item of (manifest.closeChecklist || [])) {
      if (!item.id) fail(code, `closeChecklist item missing id`);
      if (!CLOSE_OPS.has(item.op)) fail(code, `closeChecklist item '${item.id}': unknown op '${item.op}' (allowed: ${[...CLOSE_OPS].join(', ')})`);
      if (item.op === 'tax_attr_set') {
        if (!item.attr) fail(code, `closeChecklist item '${item.id}': tax_attr_set requires an 'attr'`);
        else if (!taxAttrKeys.has(item.attr)) fail(code, `closeChecklist item '${item.id}': attr '${item.attr}' is not a declared taxAttribute`);
      }
    }
  }

  // coa
  const coaPath = path.join(dir, 'coa.json');
  let coa = null;
  if (!fs.existsSync(coaPath)) fail(code, 'missing coa.json');
  else {
    try { coa = JSON.parse(fs.readFileSync(coaPath, 'utf8')); }
    catch (e) { fail(code, `coa.json does not parse: ${e.message}`); }
  }
  const codes = new Set((coa || []).map((a) => a.account_code));
  const subtypes = new Set((coa || []).map((a) => a.account_subtype).filter(Boolean));

  // closing (P2-1): when present, validate structure + account existence.
  // Must run after `coa` and `codes` are loaded. The `manifest` guard mirrors
  // the closeChecklist block above (both live inside `if (manifest)`).
  if (manifest && manifest.closing) {
    const c = manifest.closing;
    if (typeof c.required !== 'boolean') fail(code, 'closing.required must be boolean');
    if (c.required === true) {
      if (!c.retainedEarningsAccount) fail(code, 'closing.retainedEarningsAccount required when closing.required is true');
      if (!c.closingAccount) fail(code, 'closing.closingAccount required when closing.required is true');
      // Check accounts exist in COA
      if (c.closingAccount && !codes.has(c.closingAccount)) fail(code, `closing.closingAccount '${c.closingAccount}' not found in COA`);
      if (c.retainedEarningsAccount && !codes.has(c.retainedEarningsAccount)) fail(code, `closing.retainedEarningsAccount '${c.retainedEarningsAccount}' not found in COA`);
      // Check account types
      if (coa) {
        const closeAcct = coa.find(a => a.account_code === c.closingAccount);
        if (closeAcct && closeAcct.account_type !== 'Closing') fail(code, `closing.closingAccount '${c.closingAccount}' must have account_type 'Closing' (got '${closeAcct.account_type}')`);
        const reAcct = coa.find(a => a.account_code === c.retainedEarningsAccount);
        if (reAcct && reAcct.account_type !== 'Equity') fail(code, `closing.retainedEarningsAccount '${c.retainedEarningsAccount}' must have account_type 'Equity' (got '${reAcct.account_type}')`);
      }
    }
  }

  // fxRevaluation (P2-2): when present, validate structure + account existence.
  // monetaryTypes must be a non-empty array; gainLossAccount must exist in COA
  // and have account_type 'Expense' (it's a P&L account).
  if (manifest && manifest.fxRevaluation) {
    const fx = manifest.fxRevaluation;
    if (!Array.isArray(fx.monetaryTypes) || fx.monetaryTypes.length === 0)
      fail(code, 'fxRevaluation.monetaryTypes must be a non-empty array');
    if (!fx.gainLossAccount)
      fail(code, 'fxRevaluation.gainLossAccount required');
    if (fx.gainLossAccount && !codes.has(fx.gainLossAccount))
      fail(code, `fxRevaluation.gainLossAccount '${fx.gainLossAccount}' not found in COA`);
    if (fx.gainLossAccount && coa) {
      const fxAcct = coa.find(a => a.account_code === fx.gainLossAccount);
      if (fxAcct && fxAcct.account_type !== 'Expense')
        fail(code, `fxRevaluation.gainLossAccount '${fx.gainLossAccount}' must have account_type 'Expense' (got '${fxAcct.account_type}')`);
    }
  }

  // descriptors
  const filingsDir = path.join(dir, 'filings');
  if (fs.existsSync(filingsDir)) {
    for (const f of fs.readdirSync(filingsDir).filter((x) => x.endsWith('.json'))) {
      let desc = null;
      try { desc = JSON.parse(fs.readFileSync(path.join(filingsDir, f), 'utf8')); }
      catch (e) { fail(code, `filings/${f} does not parse: ${e.message}`); continue; }
      if (desc.schema !== 1) fail(code, `filings/${f}: schema must be 1`);
      // due block (IA-spec step 4, §5.10): rule must be one of the closed set
      // the engine knows how to compute. nth_day_after_period_end requires a
      // numeric `day`; fy_end_plus_months requires a numeric `months`.
      const DUE_RULES = new Set(['fy_end_plus_months', 'nth_day_after_period_end']);
      if (desc.due) {
        if (!DUE_RULES.has(desc.due.rule)) fail(code, `filings/${f}: unknown due.rule '${desc.due.rule}' (allowed: ${[...DUE_RULES].join(', ')})`);
        if (desc.due.rule === 'fy_end_plus_months' && !(Number.isFinite(desc.due.months) && desc.due.months > 0))
          fail(code, `filings/${f}: due.rule fy_end_plus_months requires a positive numeric 'months'`);
        if (desc.due.rule === 'nth_day_after_period_end' && !(Number.isFinite(desc.due.day) && desc.due.day > 0))
          fail(code, `filings/${f}: due.rule nth_day_after_period_end requires a positive numeric 'day'`);
      }
      // period_kind is optional but, when present, must be a known kind so the
      // filing.list engine can route interval generation correctly.
      const PERIOD_KINDS = new Set(['fiscal_year', 'vat_period']);
      if (desc.period_kind && !PERIOD_KINDS.has(desc.period_kind))
        fail(code, `filings/${f}: unknown period_kind '${desc.period_kind}' (allowed: ${[...PERIOD_KINDS].join(', ')})`);
      if (desc.emitter) {
        const ePath = path.join(DIR, '..', '..', 'api', 'src', 'emitters', desc.emitter + '.js');
        if (!fs.existsSync(ePath)) fail(code, `filings/${f}: emitter '${desc.emitter}' not found at api/src/emitters/${desc.emitter}.js`);
      }

      const checkRefs = (obj, where) => {
        if (obj.accounts) for (const a of obj.accounts) {
          if (!codes.has(a)) fail(code, `filings/${f} ${where}: unknown account '${a}'`);
        }
        if (obj.subtypes) for (const s of obj.subtypes) {
          if (!subtypes.has(s)) fail(code, `filings/${f} ${where}: unknown subtype '${s}'`);
        }
      };

      if (desc.fields) for (const [field, def] of Object.entries(desc.fields)) checkRefs(def, `field ${field}`);
      if (desc.variants) {
        const vks = Object.keys(desc.variants);
        if (!vks.length) fail(code, `filings/${f}: variants must be non-empty`);
        for (const [vk, v] of Object.entries(desc.variants)) {
          if (!Array.isArray(v.statements) || !v.statements.length)
            fail(code, `filings/${f} variant ${vk}: needs >= 1 statement`);
          for (const st of v.statements || []) {
            const ids = new Set(st.lines.map((l) => l.id));
            for (const l of st.lines) {
              checkRefs(l, `statement ${st.id} line ${l.id}`);
              if (l.sum) for (const ref of l.sum) {
                if (!ids.has(ref)) fail(code, `filings/${f} ${st.id}.${l.id}: sum references unknown line '${ref}'`);
              }
            }
          }
        }
      }
    }
  }
  if (!failures) console.log(`OK   ${code}`);
}

if (failures) { console.error(`\n${failures} pack validation failure(s).`); process.exit(1); }
console.log('\nAll jurisdiction packs valid.');
