const { isMetadataRow } = require('../api/src/agent-loop.js');
const rows = [
  { date: 'Magnus Davidson Utveckling AB', description: '556880-6854', amount: '' },
  { date: '', description: 'Ingående saldo 2026-01-01', amount: '3 533' },
  { date: '', description: 'Utgående saldo 2026-08-19', amount: '3 559' },
  { date: '2026-01-03', description: 'Intäktsränta', amount: '3' },
  { date: '2026-01-05', description: 'BANKGIRO', amount: '1000' },
];
let pass = 0, fail = 0;
function assert(name, cond) {
  if (cond) { pass++; console.log('ok:', name); }
  else { fail++; console.log('FAIL:', name); }
}
assert('company header is metadata', isMetadataRow(rows[0]) === true);
assert('opening saldo is metadata', isMetadataRow(rows[1]) === true);
assert('closing saldo is metadata', isMetadataRow(rows[2]) === true);
assert('real txn not metadata', isMetadataRow(rows[3]) === false);
assert('real txn2 not metadata', isMetadataRow(rows[4]) === false);
// statementDate filter rejects non-date strings
const dateRe = /^\d{4}-\d{2}-\d{2}$/;
const dates = rows.map(r => r.date);
const statementDate = dates.filter(d => d && dateRe.test(d))[0] || 'fallback';
assert('statementDate is valid date', statementDate === '2026-01-03');
assert('old buggy filter would pick company name', dates.filter(Boolean)[0] === 'Magnus Davidson Utveckling AB');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
