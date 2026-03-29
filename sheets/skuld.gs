/**
 * Query account balances from the _CACHE_BALANCES tab.
 *
 * The cache now stores CUMULATIVE balances (sum from inception through period end).
 *
 * Usage:
 * =skuld(timestamp, "FY2025", 3000)          -> Cumulative balance through FY2025
 * =skuld(timestamp, "FY2025", 3000, true)     -> Period movement (FY2025 - FY2024)
 * =skuld(timestamp, "FY2025", "pnl")          -> All P&L accounts (cumulative)
 * =skuld(timestamp, "FY2025", "bs")           -> All BS accounts (cumulative)
 * =skuld(timestamp, "FY2025", A1:A10)         -> Array of cumulative balances
 *
 * Mode (arg4):
 *   false/omitted  -> Cumulative balance (direct cache read)
 *   true           -> Period movement: current_period - previous_period (column to the left)
 *
 * Report usage:
 *   BS, TB, Cash positions  → skuld(period, code)        = cumulative
 *   PL, CF movements        → skuld(period, code, true)  = delta
 *
 * @param {*} timestamp - Named range for recalc trigger
 * @param {string} period - Period column (e.g., "FY2025", "2025P01")
 * @param {string|number|Array} filter - "pnl", "bs", "all", account code, or range
 * @param {boolean} delta - If true, return period movement (current - prior). Default false.
 * @return {Array|number|string}
 * @customfunction
 */
function skuld(timestamp, period, filter, delta) {
  if (timestamp !== undefined) { void timestamp; }
  if (!period) return "Error: Missing period";

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cacheSheet = ss.getSheetByName('_CACHE_BALANCES');
  if (!cacheSheet) return "Error: _CACHE_BALANCES not found";

  var data = cacheSheet.getDataRange().getValues();
  if (data.length < 2) return "Error: Cache empty";

  var headers = data[0];
  var periodStr = String(period).trim();
  var periodIndex = headers.indexOf(periodStr);
  if (periodIndex === -1) return "Error: Period not found";

  var acctIndex = headers.indexOf('Account Code');
  var typeIndex = headers.indexOf('Type');
  var plCatIndex = headers.indexOf('PL Category');
  var bsCatIndex = headers.indexOf('BS Category');
  if (acctIndex === -1) return "Error: Cache missing 'Account Code'";

  if (filter === undefined || filter === null || filter === '') {
    filter = 'all';
  }

  var isDelta = delta === true;

  // For delta: previous period column (immediately to the left)
  var prevPeriodIndex = -1;
  if (isDelta && periodIndex > 0) {
    prevPeriodIndex = periodIndex - 1;
  }

  // Helper: get value for a row
  function getVal(rowData) {
    var curr = Number(rowData[periodIndex]) || 0;
    if (isDelta) {
      var prev = prevPeriodIndex >= 0 ? (Number(rowData[prevPeriodIndex]) || 0) : 0;
      return curr - prev;
    }
    return curr;
  }

  var isPrimitive = typeof filter === 'string' || typeof filter === 'number';
  var queryStr = isPrimitive ? String(filter).trim() : null;
  var queryType = isPrimitive ? queryStr.toLowerCase() : null;

  // Handle standard query types returning 2D array [code, balance]
  if (queryType === 'all' || queryType === 'account_balances' || queryType === 'pnl' || queryType === 'pl' || queryType === 'bs') {
    var result = [];
    for (var i = 1; i < data.length; i++) {
      var code = String(data[i][acctIndex]).trim();
      if (!code) continue;

      var type = String(data[i][typeIndex]).trim();
      var bal = getVal(data[i]);
      var include = false;

      if (queryType === 'all' || queryType === 'account_balances') {
        include = true;
      } else if (queryType === 'pnl' || queryType === 'pl') {
        var plCat = String(data[i][plCatIndex]).trim();
        include = (type === 'Revenue' || type === 'Expense' || plCat !== '');
      } else if (queryType === 'bs') {
        var bsCat = String(data[i][bsCatIndex]).trim();
        include = (type === 'Asset' || type === 'Liability' || type === 'Equity' || bsCat !== '');
      }

      if (include) {
        result.push([code, bal]);
      }
    }
    if (result.length === 0) return [["No data", 0]];
    return result;
  }

  // Build lookup map
  var balanceMap = {};
  for (var i = 1; i < data.length; i++) {
    var code = String(data[i][acctIndex]).trim();
    if (code) {
      balanceMap[code] = getVal(data[i]);
    }
  }

  // Single account
  if (isPrimitive) {
    return balanceMap[queryStr] !== undefined ? balanceMap[queryStr] : 0;
  }

  // Array/range
  if (Array.isArray(filter)) {
    var resultArr = [];
    for (var r = 0; r < filter.length; r++) {
      var rowResult = [];
      for (var c = 0; c < filter[r].length; c++) {
        var reqCode = String(filter[r][c]).trim();
        if (!reqCode) {
          rowResult.push('');
        } else {
          rowResult.push(balanceMap[reqCode] !== undefined ? balanceMap[reqCode] : 0);
        }
      }
      resultArr.push(rowResult);
    }
    return resultArr;
  }

  return "Error: Invalid query";
}
