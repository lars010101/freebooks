'use strict';
/**
 * freeBooks — Shared utility functions
 */

function normalizeDate(val) {
  if (!val) return null;
  if (typeof val === 'string') return val.substring(0, 10);
  if (typeof val === 'object' && val.value) return String(val.value).substring(0, 10);
  return null;
}

function formatDateDisplay(dateStr) {
  const d = normalizeDate(dateStr);
  if (!d) return '—';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const parts = d.split('-');
  if (parts.length !== 3) return d;
  return `${parseInt(parts[2], 10)} ${months[parseInt(parts[1], 10) - 1]} ${parts[0]}`;
}

function formatAmount(amount) {
  if (amount === null || amount === undefined) return '0.00';
  return Number(amount).toFixed(2);
}

function validateRequired(body, required) {
  const missing = required.filter((field) => {
    const val = body[field];
    return val === undefined || val === null || val === '';
  });
  if (missing.length > 0) {
    throw Object.assign(new Error(`Missing required fields: ${missing.join(', ')}`), { code: 'MISSING_FIELDS' });
  }
}

module.exports = { normalizeDate, formatDateDisplay, formatAmount, validateRequired };
