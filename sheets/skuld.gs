/**
 * Query account balances from the _CACHE_BALANCES tab.
 *
 * Usage:
 * =SKULD("account_balances", "FY2025")       -> Returns 2D array: [account_code, balance]
 * =SKULD("account_balances_pl", "FY2025")    -> Returns 2D array of P&L accounts: [account_code, balance] 
 * =SKULD("account_balances_bs", "FY2025")    -> Returns 2D array of BS accounts: [account_code, balance]
 * =SKULD("3000", "FY2025")                   -> Returns single balance for account 3000
 * =SKULD(A1:A10, "FY2025")                   -> Returns array of balances for given accounts
 *
 * @param {string|Array} accountOrQuery - Query type OR account code(s)
 * @param {string} period - The period column to query (e.g., "FY2025", "2025-01")
 * @return {Array|number|string}
 * @customfunction
 */
function SKULD(accountOrQuery, period) {
  if (!accountOrQuery || !period) return "Error: Missing params";
  
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

  var isString = typeof accountOrQuery === 'string';
  var queryType = isString ? String(accountOrQuery).toLowerCase().trim() : null;

  // Handle standard query types returning 2D array [code, balance]
  if (queryType === 'account_balances' || queryType === 'account_balances_pl' || queryType === 'account_balances_bs') {
    var result = [];
    for (var i = 1; i < data.length; i++) {
      var code = String(data[i][acctIndex]).trim();
      if (!code) continue;
      
      var type = String(data[i][typeIndex]).trim();
      var bal = Number(data[i][periodIndex]) || 0;
      var include = false;
      
      if (queryType === 'account_balances') {
        include = true;
      } else if (queryType === 'account_balances_pl') {
        var plCat = String(data[i][plCatIndex]).trim();
        include = (type === 'Revenue' || type === 'Expense' || plCat !== '');
      } else if (queryType === 'account_balances_bs') {
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

  // Handle single account string
  if (isString) {
    return balanceMap[queryType] || 0;
  }
  
  // Handle array/range of accounts
  if (Array.isArray(accountOrQuery)) {
    var resultArr = [];
    for (var r = 0; r < accountOrQuery.length; r++) {
      var rowResult = [];
      for (var c = 0; c < accountOrQuery[r].length; c++) {
        var reqCode = String(accountOrQuery[r][c]).trim();
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
