import re

with open("sheets/relay.gs", "r") as f:
    relay = f.read()

# 1. Update TAB_CONFIG
relay = relay.replace("'Tax codes':           { color: '#9e9e9e', category: 'settings' },", "'Tax':                 { color: '#9e9e9e', category: 'settings' },")
relay = relay.replace("'VAT Codes':           { color: '#9e9e9e', category: 'settings' },", "")
relay = relay.replace("'Profit/cost centers': { color: '#9e9e9e', category: 'settings' },", "")

# 2. Update isInput array
relay = relay.replace("'Companies', 'Periods', 'Bank map', 'Tax codes', 'Profit/cost centers',", "'Companies', 'Periods', 'Bank map', 'Tax', 'Centers',")
relay = relay.replace("'COA', 'Mappings', 'Centers', 'VAT Codes', 'Import', 'Bank Processing'", "'COA', 'Mappings', 'Import', 'Bank Processing'")

# 3. Update _saveTabInternal_
save_old = """    case 'Centers':
    case 'Profit/cost centers':
      var data = readSheetData_('Centers');
      callSkuld_('center.save', { centers: data });
      return '✅ Centers saved to database';
    case 'VAT Codes':
    case 'Tax codes':
      var data = readSheetData_('VAT Codes');
      callSkuld_('vat.codes.save', { vatCodes: data });
      invalidateAccountCache_();
      return '✅ VAT Codes saved to database';"""
      
save_new = """    case 'Centers':
      var data = readSheetData_('Centers');
      callSkuld_('center.save', { centers: data });
      return '✅ Centers saved to database';
    case 'Tax':
      var data = readSheetData_('Tax');
      callSkuld_('vat.codes.save', { vatCodes: data });
      invalidateAccountCache_();
      return '✅ Tax codes saved to database';"""
relay = relay.replace(save_old, save_new)

# 4. Update menu
menu_old = """.addItem('Tax codes', 'showTaxCodes')
      .addItem('Profit/cost centers', 'showCenters')"""
menu_new = """.addItem('Tax', 'showTaxCodes')
      .addItem('Centers', 'showCenters')"""
relay = relay.replace(menu_old, menu_new)

# 5. Update navigation functions
relay = relay.replace("navigateToTab('Tax codes');", "navigateToTab('Tax');")
relay = relay.replace("navigateToTab('Profit/cost centers');", "navigateToTab('Centers');")

# 6. Update staticTabs
relay = relay.replace("'Tax codes', 'VAT Codes', 'Centers', 'Profit/cost centers',", "'Tax', 'Centers',")

# 7. Update hide
relay = relay.replace("'Centers', 'VAT Codes',", "'Centers', 'Tax',")

# 8. Add back the missing refresh cases to _refreshTabInternal_
refresh_missing = """    case 'Tax':
      var r = callSkuld_('vat.codes.list', {});
      if (r) writeToSheet_('Tax', r, ['vat_code', 'rate', 'description', 'account_code']);
      if (!r || r.length === 0) writeToSheet_('Tax', [], ['vat_code', 'rate', 'description', 'account_code']);
      return '✅ Tax codes loaded from database';
    case 'Centers':
      var r = callSkuld_('center.list', {});
      if (r) writeToSheet_('Centers', r, ['center_type', 'code', 'name', 'is_active']);
      if (!r || r.length === 0) writeToSheet_('Centers', [], ['center_type', 'code', 'name', 'is_active']);
      return '✅ Centers loaded from database';"""

# Insert before 'case 'Bank Processing':'
relay = relay.replace("    case 'Bank Processing':", refresh_missing + "\n    case 'Bank Processing':")

with open("sheets/relay.gs", "w") as f:
    f.write(relay)

