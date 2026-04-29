---
title: Balance Sheet
---

# Balance Sheet

```sql bs_summary
select
  a.bs_category,
  a.account_type,
  a.account_code,
  a.account_name,
  round(sum(je.debit_home - je.credit_home), 2) as balance
from freebooks.journal_entries je
join freebooks.accounts a
  on je.company_id = a.company_id and je.account_code = a.account_code
where a.account_type in ('Asset', 'Liability', 'Equity')
  and a.bs_category is not null
group by a.bs_category, a.account_type, a.account_code, a.account_name
order by a.bs_category, a.account_type, a.account_code
```

<DataTable data={bs_summary} groupBy=bs_category />

```sql bs_totals
select
  a.account_type,
  round(sum(je.debit_home - je.credit_home), 2) as balance
from freebooks.journal_entries je
join freebooks.accounts a
  on je.company_id = a.company_id and je.account_code = a.account_code
where a.account_type in ('Asset', 'Liability', 'Equity')
group by a.account_type
order by a.account_type
```

<BarChart data={bs_totals} x=account_type y=balance />
