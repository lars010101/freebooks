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

  // descriptors
  const filingsDir = path.join(dir, 'filings');
  if (fs.existsSync(filingsDir)) {
    for (const f of fs.readdirSync(filingsDir).filter((x) => x.endsWith('.json'))) {
      let desc = null;
      try { desc = JSON.parse(fs.readFileSync(path.join(filingsDir, f), 'utf8')); }
      catch (e) { fail(code, `filings/${f} does not parse: ${e.message}`); continue; }
      if (desc.schema !== 1) fail(code, `filings/${f}: schema must be 1`);
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
