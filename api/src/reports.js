'use strict';
/**
 * freeBooks — Report generation
 * AP Aging and VAT Return. P&L / BS are served via Evidence.dev.
 */

const { query } = require('./db');
const { generateVatReturn } = require('./vat');

async function handleReports(ctx, action) {
  switch (action) {
    case 'report.refresh_ap_aging':   return refreshAPAging(ctx);
    case 'report.refresh_vat_return': return generateVatReturn(ctx);
    default:
      throw Object.assign(new Error(`Unknown report action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

async function refreshAPAging(ctx) {
  const { companyId } = ctx;

  const rows = await query(
    `SELECT vendor, vendor_ref, due_date, amount_home, amount_paid
     FROM bills
     WHERE company_id = @companyId
       AND status != 'paid'
       AND amount_paid < amount_home`,
    { companyId }
  );

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const BUCKET_ORDER = ['Not Yet Due', '0-30 days', '31-60 days', '61-90 days', '91+ days'];
  const bucketsMap = {};

  for (const row of rows) {
    const outstanding = (Number(row.amount_home) || 0) - (Number(row.amount_paid) || 0);
    const dueDate = new Date(String(row.due_date).substring(0, 10) + 'T00:00:00Z');
    const daysPastDue = Math.floor((today - dueDate) / (1000 * 60 * 60 * 24));

    let label;
    if (daysPastDue < 0) label = 'Not Yet Due';
    else if (daysPastDue <= 30) label = '0-30 days';
    else if (daysPastDue <= 60) label = '31-60 days';
    else if (daysPastDue <= 90) label = '61-90 days';
    else label = '91+ days';

    if (!bucketsMap[label]) bucketsMap[label] = [];
    bucketsMap[label].push({ vendor: row.vendor || '', vendorRef: row.vendor_ref || '', outstanding: Math.round(outstanding * 100) / 100, daysPastDue });
  }

  for (const bills of Object.values(bucketsMap)) bills.sort((a, b) => b.daysPastDue - a.daysPastDue);

  const buckets = BUCKET_ORDER
    .filter((label) => bucketsMap[label])
    .map((label) => {
      const bills = bucketsMap[label];
      const total = Math.round(bills.reduce((sum, b) => sum + b.outstanding, 0) * 100) / 100;
      return { label, total, bills };
    });

  return {
    report: 'ap_aging',
    buckets,
    totalOutstanding: Math.round(buckets.reduce((sum, b) => sum + b.total, 0) * 100) / 100,
  };
}

module.exports = { handleReports };
