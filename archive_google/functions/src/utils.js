/**
 * Skuld — Shared utility functions
 * 
 * Date normalization, formatting, and common helpers.
 */

/**
 * Normalize a date value from BigQuery or input.
 * BigQuery returns dates as { value: 'YYYY-MM-DD' } or as strings.
 * Handles both safely.
 * @param {string|object|null} val - Date value
 * @returns {string|null} - ISO date string (YYYY-MM-DD) or null
 */
function normalizeDate(val) {
  if (!val) return null;
  if (typeof val === 'string') return val.substring(0, 10);
  if (typeof val === 'object' && val.value) return String(val.value).substring(0, 10);
  return null;
}

/**
 * Format date for display in reports.
 * @param {string} dateStr - ISO date string
 * @returns {string} - Formatted like "31 Jan 2025"
 */
function formatDateDisplay(dateStr) {
  const d = normalizeDate(dateStr);
  if (!d) return '—';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const parts = d.split('-');
  if (parts.length !== 3) return d;
  return `${parseInt(parts[2], 10)} ${months[parseInt(parts[1], 10) - 1]} ${parts[0]}`;
}

/**
 * Format amount as currency with 2 decimals.
 * @param {number} amount
 * @returns {string}
 */
function formatAmount(amount) {
  if (amount === null || amount === undefined) return '0.00';
  return Number(amount).toFixed(2);
}

/**
 * Validate required fields in a request body.
 * @param {object} body - Request body
 * @param {string[]} required - Array of required field names
 * @throws {Error} - If any required field is missing
 */
function validateRequired(body, required) {
  const missing = required.filter(field => {
    const val = body[field];
    return val === undefined || val === null || val === '';
  });
  if (missing.length > 0) {
    throw Object.assign(new Error(`Missing required fields: ${missing.join(', ')}`), { 
      code: 'MISSING_FIELDS' 
    });
  }
}

module.exports = { normalizeDate, formatDateDisplay, formatAmount, validateRequired };
