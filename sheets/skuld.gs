/**
 * Query account balances from the _CACHE_BALANCES tab.
 *
 * Usage:
 * =skuld("FY2025")               -> Returns 2D array: [account_code, balance] for all accounts
 * =skuld("FY2025", "all")        -> Same as above
 * =skuld("FY2025", "pnl")        -> Returns 2D array of P&L accounts: [account_code, balance] 
 * =skuld("FY2025", "bs")         -> Returns 2D array of BS accounts: [account_code, balance]
 * =skuld("FY2025", "3000")       -> Returns single balance for account 3000
 * =skuld("FY2025", A1:A10)       -> Returns array of balances for given accounts
 * =skuld("FY2025", "pnl", A1)    -> Returns filtered results; reads A1 as recalc trigger
 *
 * @param {string} period - The period column to query (e.g., "FY2025", "2025-01")
 * @param {string|Array} [accountFilter] - Optional. "all", "pnl", "bs", or specific account code(s). Defaults to "all".
 * @param {*} [recalcTrigger] - Optional. If provided, the function reads this value so Sheets auto-recalculates when it changes.
 * @return {Array|number|string}
 * @customfunction
 */
function skuld(period, accountFilter, recalcTrigger) {
  // Access recalcTrigger to mark it as a dependency (prevents "unnecessary recalculation" optimization)
  if (recalcTrigger !== undefined) { void recalcTrigger; }
  
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
  if (accountFilter === undefined || accountFilter === null || accountFilter === '') {
    accountFilter = 'all';
  }

  var isPrimitive = typeof accountFilter === 'string' || typeof accountFilter === 'number';
  var queryStr = isPrimitive ? String(accountFilter).trim() : null;
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
  
  // Build lookup map for account-specific queries
  var balanceMap = {};
  for (var i = 1; i < data.length; i++) {
    var code = String(data[i][acctIndex]).trim();
    if (code) {
      balanceMap[code] = Number(data[i][periodIndex]) || 0;
    }
  }

  // Handle single account primitive
  if (isPrimitive) {
    return balanceMap[queryStr] || 0;
  }
  
  // Handle array/range of accounts
  if (Array.isArray(accountFilter)) {
    var resultArr = [];
    for (var r = 0; r < accountFilter.length; r++) {
      var rowResult = [];
      for (var c = 0; c < accountFilter[r].length; c++) {
        var reqCode = String(accountFilter[r][c]).trim();
        if (!reqCode) {
          rowResult.push('');
        } else {
          rowResult.push(balanceMap[reqCode] || 0);
        }
      }
      resultArr.push(rowResult);
    }
    return resultArr;
  }
  
  return "Error: Invalid query";
}
