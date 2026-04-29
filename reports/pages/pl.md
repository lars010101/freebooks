---
title: Profit & Loss
---

# Profit & Loss

```sql pl_summary
select
  a.pl_category,
  a.account_type,
  a.account_code,
  a.account_name,
  round(sum(je.debit_home - je.credit_home), 2) as net_movement
from freebooks.journal_entries je
join freebooks.accounts a
  on je.company_id = a.company_id and je.account_code = a.account_code
where a.account_type in ('Revenue', 'Expense')
  and a.pl_category is not null
group by a.pl_category, a.account_type, a.account_code, a.account_name
order by a.pl_category, a.account_type, a.account_code
```

<DataTable data={pl_summary} groupBy=pl_category />

```sql pl_totals
select
  a.account_type,
  round(sum(je.debit_home - je.credit_home), 2) as total
from freebooks.journal_entries je
join freebooks.accounts a
  on je.company_id = a.company_id and je.account_code = a.account_code
where a.account_type in ('Revenue', 'Expense')
group by a.account_type
order by a.account_type
```

<BarChart data={pl_totals} x=account_type y=total />
