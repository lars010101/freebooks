#!/usr/bin/env node
// Extract the template-literal JS from a page module and syntax-check it.
// node --check on the module itself only validates the OUTER file; the page
// script inside the backtick string is opaque to it. This harness evals the
// producer to get the string, writes it to a temp file, and node --checks it.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const mod = require(path.resolve(process.argv[2]));
const fnName = process.argv[3]; // e.g. billsTabJS
const fn = mod[fnName];
if (typeof fn !== 'function') { console.error('no export ' + fnName); process.exit(2); }
const src = fn();
const tmp = '/tmp/page-extract-' + fnName + '.js';
fs.writeFileSync(tmp, src);
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  console.log('OK ' + fnName + ' (' + src.length + ' chars)');
} catch (e) {
  console.error('SYNTAX ERROR in ' + fnName + ':');
  console.error(e.stderr ? e.stderr.toString() : e.message);
  process.exit(1);
}
