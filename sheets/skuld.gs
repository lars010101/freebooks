/**
 * Query account balances from the _CACHE_BALANCES tab.
 *
 * Usage:
 * =skuld(timestamp, "FY2025")            -> All accounts (raw balances)
 * =skuld(timestamp, "FY2025", "pnl")     -> P&L accounts only
 * =skuld(timestamp, "FY2025", "bs")      -> Balance Sheet accounts only
 * =skuld(timestamp, "FY2025", 3000)      -> Single account balance (raw)
 * =skuld(timestamp, "FY2025", 3000, true) -> Single account DELTA (current period - prior period)
 * =skuld(timestamp, "FY2025", A1:A10)   -> Array of balances for given account codes
 *
 * Delta mode (arg4 = true):
 *   - Returns current_period_balance - previous_period_balance
 *   - First column (no prior): returns current_period_balance - 0 = current_period_balance
 *   - Works for single account codes and account code ranges
 *
 * @param {*} timestamp - Must be the `timestamp` named range (forces auto-recalculate on cache rebuild)
 * @param {string} period - The period column to query (e.g., "FY2025", "2025-01")
 * @param {string|Array} filter - "pnl", "bs", or specific account code(s). Defaults to all accounts.
 * @param {boolean} delta - If true, return period-over-period delta. Default false.
 * @return {Array|number|string}
 * @customfunction
 */
function skuld(timestamp, period, filter, delta) {
  // Access timestamp to mark it as a dependency
  if (timestamp !== undefined) { void timestamp; }

  if (!period) return "Error: Missing period";

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cacheSheet = ss.getSheetByName('_CACHE_BALANCES');
  if (!cacheSheet) return "Error: _CACHE_BALANCES not found";

  // Get data as an array (reading entire sheet is fast)
  var data = cacheSheet.getDataRange().getValues();
  if (data.length < 2) return "Error: Cache empty";

  var headers = data[0];
  var periodIndex = headers.indexOf(String(period).trim());
  if (periodIndex === -1) return "Error: Period not found";

  var acctIndex = headers.indexOf('Account Code');
  var typeIndex = headers.indexOf('Type');
  var plCatIndex = headers.indexOf('PL Category');
  var bsCatIndex = headers.indexOf('BS Category');

  if (acctIndex === -1) return "Error: Cache missing 'Account Code'";

  // Default to 'all' if omitted
  if (filter === undefined || filter === null || filter === '') {
    filter = 'all';
  }

  // Delta mode: false unless explicitly true
  var isDelta = delta === true;

  // For delta mode, find the previous period column (always immediately to the left)
  var prevPeriodIndex = -1;
  if (isDelta && periodIndex > 0) {
    prevPeriodIndex = periodIndex - 1;
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
      var bal = Number(data[i][periodIndex]) || 0;
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

  // Build lookup maps: current period (+ previous period if delta)
  var balanceMap = {};
  var prevBalanceMap = {};
  for (var i = 1; i < data.length; i++) {
    var code = String(data[i][acctIndex]).trim();
    if (code) {
      balanceMap[code] = Number(data[i][periodIndex]) || 0;
      if (isDelta && prevPeriodIndex >= 0) {
        prevBalanceMap[code] = Number(data[i][prevPeriodIndex]) || 0;
      }
    }
  }

  // Handle single account primitive
  if (isPrimitive) {
    var curr = balanceMap[queryStr] !== undefined ? balanceMap[queryStr] : 0;
    if (isDelta) {
      var prev = prevBalanceMap[queryStr] !== undefined ? prevBalanceMap[queryStr] : 0;
      return curr - prev;
    }
    return curr;
  }

  // Handle array/range of accounts
  if (Array.isArray(filter)) {
    var resultArr = [];
    for (var r = 0; r < filter.length; r++) {
      var rowResult = [];
      for (var c = 0; c < filter[r].length; c++) {
        var reqCode = String(filter[r][c]).trim();
        if (!reqCode) {
          rowResult.push('');
        } else {
          var curr = balanceMap[reqCode] !== undefined ? balanceMap[reqCode] : 0;
          if (isDelta) {
            var prev = prevBalanceMap[reqCode] !== undefined ? prevBalanceMap[reqCode] : 0;
            rowResult.push(curr - prev);
          } else {
            rowResult.push(curr);
          }
        }
      }
      resultArr.push(rowResult);
    }
    return resultArr;
  }

  return "Error: Invalid query";
}
