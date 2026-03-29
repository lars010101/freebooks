/**
 * Query account balances from the _CACHE_BALANCES tab.
 *
 * Usage:
 * =skuld(timestamp, "FY2025", 3000)          -> Period movement (raw)
 * =skuld(timestamp, "FY2025", 3000, true)     -> Delta vs prior period column
 * =skuld(timestamp, "FY2025", 3000, "cum")    -> Cumulative balance through FY2025
 * =skuld(timestamp, "FY2025", "pnl")          -> All P&L accounts (raw)
 * =skuld(timestamp, "FY2025", "bs")           -> All BS accounts (raw)
 * =skuld(timestamp, "FY2025", A1:A10)         -> Array of balances
 * =skuld(timestamp, "FY2025", A1:A10, "cum")  -> Array of cumulative balances
 *
 * Mode (arg4):
 *   false/omitted  -> Raw period movement (cache value for that period column)
 *   true           -> Delta: current_period - previous_period
 *   "cum"          -> Cumulative: sum of all FY period columns up to and including selected
 *
 * The cache stores SUM(debit - credit) per account per period (movements, not cumulative).
 * Use "cum" for balance sheet positions (e.g. cash balance at end of period).
 *
 * @param {*} timestamp - Named range for recalc trigger
 * @param {string} period - Period column (e.g., "FY2025", "2025P01")
 * @param {string|number|Array} filter - "pnl", "bs", "all", account code, or range
 * @param {boolean|string} mode - false=raw, true=delta, "cum"=cumulative
 * @return {Array|number|string}
 * @customfunction
 */
function skuld(timestamp, period, filter, mode) {
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

  // Default filter
  if (filter === undefined || filter === null || filter === '') {
    filter = 'all';
  }

  // Determine mode
  var isDelta = mode === true;
  var isCum   = (typeof mode === 'string' && mode.toLowerCase() === 'cum');

  // For delta: previous period column (immediately to the left)
  var prevPeriodIndex = -1;
  if (isDelta && periodIndex > 0) {
    prevPeriodIndex = periodIndex - 1;
  }

  // For cumulative: find all FY columns up to and including the selected period
  // Only sum columns that match the same pattern (FY* or YYYYP*)
  var cumColIndices = [];
  if (isCum) {
    var isFY = /^FY\d{4}$/.test(periodStr);
    var isMonthly = /^\d{4}P\d{2}$/.test(periodStr);
    for (var ci = 0; ci < headers.length; ci++) {
      var h = String(headers[ci] || '').trim();
      if (isFY && /^FY\d{4}$/.test(h) && h.localeCompare(periodStr, undefined, {numeric: true}) <= 0) {
        cumColIndices.push(ci);
      } else if (isMonthly && /^\d{4}P\d{2}$/.test(h) && h.localeCompare(periodStr, undefined, {numeric: true}) <= 0) {
        cumColIndices.push(ci);
      }
    }
  }

  // Helper: get balance for an account row
  function getBalance(rowData) {
    if (isCum) {
      var sum = 0;
      for (var ci = 0; ci < cumColIndices.length; ci++) {
        sum += Number(rowData[cumColIndices[ci]]) || 0;
      }
      return sum;
    } else if (isDelta) {
      var curr = Number(rowData[periodIndex]) || 0;
      var prev = prevPeriodIndex >= 0 ? (Number(rowData[prevPeriodIndex]) || 0) : 0;
      return curr - prev;
    } else {
      return Number(rowData[periodIndex]) || 0;
    }
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
      var bal = getBalance(data[i]);
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

  // Build lookup map(s)
  var balanceMap = {};
  for (var i = 1; i < data.length; i++) {
    var code = String(data[i][acctIndex]).trim();
    if (code) {
      balanceMap[code] = getBalance(data[i]);
    }
  }

  // Handle single account primitive
  if (isPrimitive) {
    return balanceMap[queryStr] !== undefined ? balanceMap[queryStr] : 0;
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
          rowResult.push(balanceMap[reqCode] !== undefined ? balanceMap[reqCode] : 0);
        }
      }
      resultArr.push(rowResult);
    }
    return resultArr;
  }

  return "Error: Invalid query";
}
