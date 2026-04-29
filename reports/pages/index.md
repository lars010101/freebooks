---
title: freeBooks — Dashboard
---

# freeBooks

Welcome to your financial reports.

```sql companies
select company_id, company_name, currency, jurisdiction
from freebooks.companies
order by company_name
```

<DataTable data={companies} />

**Navigate to:**
- [Profit & Loss](/pl)
- [Balance Sheet](/bs)
