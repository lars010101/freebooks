'use strict';
/**
 * freeBooks — Vendor Master
 * Simple CRUD for vendors table. Follows pattern of journals and bank_mappings.
 */

const { v4: uuid } = require('uuid');
const { query, exec, bulkInsert } = require('./db');

async function handleVendors(ctx, action) {
  switch (action) {
    case 'vendor.list':  return listVendors(ctx);
    case 'vendor.save':  return saveVendors(ctx);
    case 'vendor.delete': return deleteVendor(ctx);
    default:
      throw Object.assign(new Error(`Unknown vendor action: ${action}`), { code: 'UNKNOWN_ACTION' });
  }
}

async function listVendors(ctx) {
  const { companyId } = ctx;
  return query(
    `SELECT vendor_id, name, default_currency, payment_terms_days, tax_id, notes, is_active 
     FROM vendors 
     WHERE company_id = @companyId 
     ORDER BY name`,
    { companyId }
  );
}

async function saveVendors(ctx) {
  const { companyId, body } = ctx;
  const { vendors } = body;
  if (!Array.isArray(vendors)) throw Object.assign(new Error('vendors array required'), { code: 'INVALID_INPUT' });

  // Replace all for the company (simple replace pattern like periods or mappings)
  await exec(`DELETE FROM vendors WHERE company_id = @companyId`, { companyId });

  if (vendors.length === 0) return { saved: true, count: 0 };

  const rows = vendors.map(v => ({
    vendor_id: v.vendor_id || uuid(),
    company_id: companyId,
    name: v.name,
    default_currency: v.default_currency || null,
    payment_terms_days: v.payment_terms_days || 30,
    tax_id: v.tax_id || null,
    notes: v.notes || null,
    is_active: v.is_active !== false
  }));

  await bulkInsert('vendors', rows);
  return { saved: true, count: rows.length };
}

async function deleteVendor(ctx) {
  const { companyId, body } = ctx;
  const { vendorId } = body;
  if (!vendorId) throw Object.assign(new Error('vendorId required'), { code: 'INVALID_INPUT' });

  await exec(
    `DELETE FROM vendors WHERE company_id = @companyId AND vendor_id = @vendorId`,
    { companyId, vendorId }
  );
  return { deleted: true, vendorId };
}

module.exports = { handleVendors };
