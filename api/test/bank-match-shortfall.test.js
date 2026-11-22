'use strict';
/**
 * freeBooks — issue #303: bank-match early_payment_discount / bank_fee_netted
 * approvals close the bill instead of leaving it permanently part-paid.
 *
 * Default (full) settlement on a home-currency bill paid short:
 *   DR AP outstanding / CR Input VAT (discount's VAT share, signed vat_adjust)
 *   / CR Discount received (rest) — or CR Bank charges for a netted fee —
 *   / CR Bank (bank amount). The bill is paid on approve.
 * ~ (bank.match.toggleSettlement) flips to partial: plain pay-down.
 * A missing role account blocks approval with a pointer to Settings.
 *
 * Black-box over the action API, VAT-registered SE company (SE25 = 25%,
 * input account 2641). Run: npm test (in api/).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, sql, testDates } = require('../test-utils/helpers');
const TD = testDates();

let srv;
let baseUrl;
const CO = 'BMS';
const OWNER = 'owner@bms';
const AGENT = 'agent@bms';
const AP = '2440';
const EXP = '4010';
const BANK = '1930';
const VAT_IN_25 = '2641';
const DISCOUNT = '4731';
const BANK_CHARGES = '6571';

before(async () => {
  srv = await startTestServer({ withAdminToken: true });
  baseUrl = srv.baseUrl;
  const c = await api(baseUrl, 'setup.add_company', {
    company: {
      company_id: CO, company_name: 'BMS Test AB', jurisdiction: 'SE', currency: 'SEK',
      fy_start: TD.fyStart, fy_end: TD.fyEnd, vat_registered: true,
    },
  });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  await api(baseUrl, 'period.upsert', { companyId: CO, period: { period_id: TD.periodId, start_date: TD.startDate, end_date: TD.endDate } });
  await sql(baseUrl, srv.adminToken,
    `INSERT INTO user_permissions (email, company_id, role, granted_at, granted_by)
     VALUES ('${OWNER}', '${CO}', 'owner', now(), 'test'), ('${AGENT}', '${CO}', 'agent', now(), 'test')`);
});

after(async () => { await srv.cleanup(); });

async function createBill(ref, net, vatCode) {
  const r = await api(baseUrl, 'bill.create', {
    companyId: CO, userEmail: OWNER,
    bill: {
      partner_name: 'Leverantör AB', vendor_ref: ref, date: TD.day20, due_date: TD.day25,
      currency: 'SEK', ap_account: AP,
      lines: [{ description: 'Varor', expense_account: EXP, amount: net, vat_code: vatCode }],
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.data.billId;
}

async function match(amount, ref) {
  const m = await api(baseUrl, 'bank.match', {
    companyId: CO, bankAccount: BANK,
    line: { date: TD.day21, amount: -amount, description: `BETALNING ${ref}` },
  });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(m.body.data.matched, true);
  return m.body.data;
}

async function propose(data, tag) {
  const p = await api(baseUrl, 'journal.propose', {
    companyId: CO, userEmail: AGENT, requestId: `req-${tag}-${Date.now()}`,
    lines: data.lines, _match_meta: { settlement: data.settlement },
  });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  return p.body.data.proposalId;
}

async function addRoleAccount(code, name, type, role) {
  const r = await api(baseUrl, 'coa.upsert', {
    companyId: CO,
    account: { account_code: code, account_name: name, account_type: type, is_active: true, default_role: role, effective_from: TD.startDate },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

test('#303: missing role account blocks the full settlement; partial toggle still approves as a pay-down', async () => {
  // 1000 net + 250 VAT = 1250; bank 1230 → 1.6% short → early_payment_discount.
  const billId = await createBill('RAB-0', 1000, 'SE25');
  const data = await match(1230, 'RAB-0');
  assert.equal(data.evidence[0].discrepancy_type, 'early_payment_discount');
  assert.equal(data.settlement.kind, 'shortfall');
  assert.equal(data.settlement.blocked, true);
  assert.match(data.settlement.blockedReason, /Discount received/);

  const proposalId = await propose(data, 'blocked');
  const refused = await api(baseUrl, 'journal.approve', { companyId: CO, userEmail: OWNER, proposalId });
  assert.notEqual(refused.status, 200, 'blocked settlement must refuse approval');

  const t = await api(baseUrl, 'bank.match.toggleSettlement', { companyId: CO, userEmail: OWNER, proposalId, billId });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.equal(t.body.data.mode, 'partial');
  const ok = await api(baseUrl, 'journal.approve', { companyId: CO, userEmail: OWNER, proposalId });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const bill = await sql(baseUrl, srv.adminToken, `SELECT status, amount_paid FROM bills WHERE company_id='${CO}' AND bill_id='${billId}'`);
  assert.equal(String(bill[0].status), 'posted');
  assert.ok(near(bill[0].amount_paid, 1230));
});

test('#303: early_payment_discount closes the bill — VAT share off input VAT, rest to Discount received', async () => {
  await addRoleAccount(DISCOUNT, 'Erhållna rabatter', 'Expense', 'Discount received');
  const billId = await createBill('RAB-1', 1000, 'SE25');
  const data = await match(1230, 'RAB-1');
  assert.equal(data.settlement.blocked, false);
  assert.equal(data.settlement.mode, 'full');

  const by = (code) => data.lines.find((l) => l.account_code === code);
  assert.ok(near(by(AP).debit, 1250), 'AP cleared in full');
  assert.ok(near(by(VAT_IN_25).credit, 4), 'shortfall 20 × 250/1250 = 4.00 off input VAT');
  assert.ok(near(by(DISCOUNT).credit, 16), 'remaining 16.00 to Discount received');
  assert.ok(near(by(BANK).credit, 1230));

  const proposalId = await propose(data, 'disc');
  const ok = await api(baseUrl, 'journal.approve', { companyId: CO, userEmail: OWNER, proposalId });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));

  const bill = await sql(baseUrl, srv.adminToken, `SELECT status, amount_paid FROM bills WHERE company_id='${CO}' AND bill_id='${billId}'`);
  assert.equal(String(bill[0].status), 'paid', 'bill closes — no permanent residue');
  assert.ok(near(bill[0].amount_paid, 1250));
  const pay = await sql(baseUrl, srv.adminToken, `SELECT amount FROM payments WHERE company_id='${CO}' AND bill_id='${billId}'`);
  assert.ok(near(pay[0].amount, 1230), 'payments.amount is the real bank movement');

  // VAT return basis (vat.js sums vat_amount_home / net_amount_home per code):
  // the bill's own line (+250 / +1000) nets with the discount line (−4 / −16).
  const vat = await sql(baseUrl, srv.adminToken,
    `SELECT SUM(vat_amount_home) AS vat, SUM(net_amount_home) AS net FROM journal_entries
     WHERE company_id='${CO}' AND bill_id='${billId}' AND vat_code='SE25'`);
  assert.ok(near(vat[0].vat, 246), `input VAT reduced to 246 (got ${vat[0].vat})`);
  assert.ok(near(vat[0].net, 984), `taxable base reduced to 984 (got ${vat[0].net})`);
});

test('#303: toggle full → partial → full rebuilds the tagged lines around the same bank amount', async () => {
  const billId = await createBill('RAB-2', 1000, 'SE25');
  const data = await match(1230, 'RAB-2');
  const proposalId = await propose(data, 'toggle');

  const t1 = await api(baseUrl, 'bank.match.toggleSettlement', { companyId: CO, userEmail: OWNER, proposalId, billId });
  assert.equal(t1.body.data.mode, 'partial');
  let row = await sql(baseUrl, srv.adminToken, `SELECT lines, match_meta FROM journal_proposals WHERE company_id='${CO}' AND proposal_id='${proposalId}'`);
  let lines = JSON.parse(row[0].lines);
  assert.equal(lines.length, 2, 'partial: AP + bank only');
  assert.equal(JSON.parse(row[0].match_meta).settlement.kind, 'shortfall', 'kind survives the toggle');

  const t2 = await api(baseUrl, 'bank.match.toggleSettlement', { companyId: CO, userEmail: OWNER, proposalId, billId });
  assert.equal(t2.body.data.mode, 'full');
  row = await sql(baseUrl, srv.adminToken, `SELECT lines FROM journal_proposals WHERE company_id='${CO}' AND proposal_id='${proposalId}'`);
  lines = JSON.parse(row[0].lines);
  assert.equal(lines.length, 4, 'full: AP + VAT + discount + bank');
  const dr = lines.reduce((s, l) => s + Number(l.debit || 0), 0);
  const cr = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
  assert.ok(near(dr, cr), 'balanced');
  assert.ok(near(lines.find((l) => l.account_code === BANK).credit, 1230), 'bank side unchanged');
});

test('#303: bank_fee_netted closes the bill to Bank charges, no VAT split', async () => {
  await addRoleAccount(BANK_CHARGES, 'Bankkostnader', 'Expense', 'Bank charges');
  // 5000 net, no VAT; bank 4975 → delta 25 (0.5%: below the 1% discount floor, inside the 5–50 fee band).
  const billId = await createBill('FEE-1', 5000, '');
  const data = await match(4975, 'FEE-1');
  assert.equal(data.evidence[0].discrepancy_type, 'bank_fee_netted');
  assert.equal(data.settlement.blocked, false);
  assert.equal(data.lines.length, 3);
  assert.ok(near(data.lines.find((l) => l.account_code === BANK_CHARGES).credit, 25));

  const proposalId = await propose(data, 'fee');
  const ok = await api(baseUrl, 'journal.approve', { companyId: CO, userEmail: OWNER, proposalId });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const bill = await sql(baseUrl, srv.adminToken, `SELECT status, amount_paid FROM bills WHERE company_id='${CO}' AND bill_id='${billId}'`);
  assert.equal(String(bill[0].status), 'paid');
  assert.ok(near(bill[0].amount_paid, 5000));
});
