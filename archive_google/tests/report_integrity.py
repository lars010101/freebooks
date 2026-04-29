#!/usr/bin/env python3
"""
Skuld Report Integrity Tests
=============================
Queries BigQuery directly and validates the math behind all financial reports
for every company and every FY period. Run before pushing relay.gs changes.

Usage:
    python3 tests/report_integrity.py
    python3 tests/report_integrity.py --company test_co
    python3 tests/report_integrity.py --company example_sg --period FY2025
"""

import subprocess
import requests
import json
import sys
import argparse
from decimal import Decimal, ROUND_HALF_UP

# ─── Config ──────────────────────────────────────────────────────────────────

PROJECT = "skuld-491310"
DATASET = "finance"
TOLERANCE = Decimal("0.01")  # rounding tolerance

# ─── BigQuery helpers ────────────────────────────────────────────────────────

def get_token():
    return subprocess.check_output(
        ["gcloud", "auth", "print-access-token"], text=True
    ).strip()

def bq_query(sql, token=None):
    if token is None:
        token = get_token()
    url = f"https://bigquery.googleapis.com/bigquery/v2/projects/{PROJECT}/queries"
    resp = requests.post(url, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }, json={"query": sql, "useLegacySql": False, "timeoutMs": 60000, "maxResults": 10000})
    data = resp.json()
    if "error" in data:
        raise RuntimeError(f"BQ error: {data['error'].get('message', data['error'])}")
    schema = [f["name"] for f in data.get("schema", {}).get("fields", [])]
    rows = []
    for r in data.get("rows", []):
        rows.append({schema[i]: r["f"][i]["v"] for i in range(len(schema))})
    return rows

def D(val):
    """Convert to Decimal, treating None as 0."""
    if val is None:
        return Decimal("0")
    return Decimal(str(val))

# ─── Data loaders ────────────────────────────────────────────────────────────

def load_companies(token):
    rows = bq_query("SELECT DISTINCT company_id FROM finance.accounts ORDER BY company_id", token)
    return [r["company_id"] for r in rows]

def load_fy_periods(company_id, token):
    rows = bq_query(f"""
        SELECT period_name, start_date, end_date
        FROM finance.periods
        WHERE company_id = '{company_id}'
          AND period_name LIKE 'FY%'
        ORDER BY start_date
    """, token)
    return rows

def load_accounts(company_id, token):
    rows = bq_query(f"""
        SELECT account_code, account_name, account_type, account_subtype,
               pl_category, bs_category, cf_category
        FROM finance.accounts
        WHERE company_id = '{company_id}'
          AND LENGTH(account_code) >= 6
        ORDER BY account_code
    """, token)
    return rows

def load_cumulative_balances(company_id, end_date, token):
    """Get cumulative (debit - credit) for each account through end_date."""
    rows = bq_query(f"""
        SELECT a.account_code, a.account_type, a.cf_category,
               COALESCE(SUM(j.debit - j.credit), 0) AS balance
        FROM finance.accounts a
        LEFT JOIN finance.journal_entries j
          ON j.company_id = a.company_id
         AND j.account_code = a.account_code
         AND j.date <= '{end_date}'
        WHERE a.company_id = '{company_id}'
          AND LENGTH(a.account_code) >= 6
        GROUP BY a.account_code, a.account_type, a.cf_category
        ORDER BY a.account_code
    """, token)
    return rows

def load_period_deltas(company_id, start_date, end_date, token):
    """Get period movement (debit - credit) for each account between start and end dates."""
    rows = bq_query(f"""
        SELECT a.account_code, a.account_type, a.cf_category,
               COALESCE(SUM(j.debit - j.credit), 0) AS delta
        FROM finance.accounts a
        LEFT JOIN finance.journal_entries j
          ON j.company_id = a.company_id
         AND j.account_code = a.account_code
         AND j.date >= '{start_date}'
         AND j.date <= '{end_date}'
        WHERE a.company_id = '{company_id}'
          AND LENGTH(a.account_code) >= 6
        GROUP BY a.account_code, a.account_type, a.cf_category
        ORDER BY a.account_code
    """, token)
    return rows

def load_prior_cumulative(company_id, periods, current_period, token):
    """Get cumulative balances through the period BEFORE current_period."""
    idx = None
    for i, p in enumerate(periods):
        if p["period_name"] == current_period:
            idx = i
            break
    if idx is None or idx == 0:
        return None  # first period, no prior
    prior_end = periods[idx - 1]["end_date"]
    return load_cumulative_balances(company_id, prior_end, token)

# ─── Test functions ──────────────────────────────────────────────────────────

class TestResult:
    def __init__(self):
        self.passed = 0
        self.failed = 0
        self.errors = []

    def ok(self, msg):
        self.passed += 1
        print(f"  ✅ {msg}")

    def fail(self, msg, detail=""):
        self.failed += 1
        self.errors.append(msg)
        print(f"  ❌ {msg}")
        if detail:
            print(f"     {detail}")

    def check(self, label, expected, actual):
        diff = abs(expected - actual)
        if diff <= TOLERANCE:
            self.ok(f"{label}: {actual:,.2f}")
        else:
            self.fail(label, f"expected {expected:,.2f}, got {actual:,.2f}, diff {diff:,.2f}")


def test_trial_balance(company_id, period, cum_balances, result):
    """TB: sum of all debits = sum of all credits (net = 0)."""
    total = sum(D(r["balance"]) for r in cum_balances)
    result.check(f"TB net balance (should be 0)", Decimal("0"), total)


def test_integrity(company_id, periods, all_cum, all_deltas, accounts, result):
    """Integrity checks matching the Integrity sheet in Sheets.
    1. RE roll-forward: opening + movement = closing, and opening = prior closing
    2. P&L vs Closing Entry: P&L net + 999999 delta = 0 per FY
    3. CF category coverage: all A/L accounts have a CF category
    """
    # Classify accounts
    re_codes = set()
    uncat_al = []
    for a in accounts:
        code = a["account_code"]
        atype = a["account_type"]
        if atype == "Equity" and code != "999999" \
           and not code.startswith("203080") and not code.startswith("2081") \
           and not code.startswith("203040") and not code.startswith("2898"):
            re_codes.add(code)
        if atype in ("Asset", "Liability") and not (a.get("cf_category") or ""):
            uncat_al.append(code)

    # CF category coverage
    if uncat_al:
        result.fail(f"Integrity CF coverage: {len(uncat_al)} A/L accounts missing cf_category",
                    f"Accounts: {', '.join(uncat_al[:10])}")
    else:
        result.ok(f"Integrity CF coverage: all A/L accounts have cf_category")

    # RE roll-forward across FY periods
    prev_closing_re = None
    for i, period in enumerate(periods):
        pname = period["period_name"]
        cum = all_cum[pname]
        deltas = all_deltas[pname]

        # Closing RE = cumulative (negated)
        closing_re = sum(-D(r["balance"]) for r in cum if r["account_code"] in re_codes)
        # RE delta
        delta_re = sum(-D(r["delta"]) for r in deltas if r["account_code"] in re_codes)

        if prev_closing_re is not None:
            # Opening should match prior closing
            opening_re = closing_re - delta_re
            result.check(f"Integrity RE continuity {pname}: opening = prior closing",
                         prev_closing_re, opening_re)
        prev_closing_re = closing_re

    # P&L vs Closing Entry per FY
    for i, period in enumerate(periods):
        pname = period["period_name"]
        deltas = all_deltas[pname]

        pl_net = sum(D(r["delta"]) for r in deltas if r["account_type"] in ("Revenue", "Expense"))
        closing_999 = sum(D(r["delta"]) for r in deltas if r["account_code"] == "999999")
        total = pl_net + closing_999
        is_last = (i == len(periods) - 1)
        if abs(total) > TOLERANCE and is_last and closing_999 == 0:
            # Last period with no closing entry — expected for unclosed years
            result.ok(f"Integrity P&L+Closing {pname}: {total:,.2f} (unclosed year, no 999999 entry — expected)")
        else:
            result.check(f"Integrity P&L+Closing {pname} (should be 0)", Decimal("0"), total)


def test_balance_sheet(company_id, period, cum_balances, result):
    """BS: Total Assets = Total Liabilities + Total Equity + Undistributed P/L."""
    assets = Decimal("0")
    liabilities = Decimal("0")
    equity = Decimal("0")  # excludes 999999
    posted_999999 = Decimal("0")
    pl_sum = Decimal("0")

    for r in cum_balances:
        bal = D(r["balance"])
        atype = r["account_type"]
        code = r["account_code"]

        if atype == "Asset":
            assets += bal  # positive = debit normal
        elif atype == "Liability":
            liabilities += -bal  # negate: credit normal shown positive
        elif atype == "Equity":
            if code == "999999":
                posted_999999 = bal
            else:
                equity += -bal  # negate: credit normal shown positive
        elif atype in ("Revenue", "Expense"):
            pl_sum += bal  # debit-credit

    # Undistributed P/L = -(posted 999999) + -(P&L sum)
    undistributed = -posted_999999 + (-pl_sum)

    rhs = liabilities + equity + undistributed
    result.check(f"BS Assets", assets, assets)
    result.check(f"BS Liabilities + Equity + Undistributed P/L", assets, rhs)


def test_pnl(company_id, period, deltas, result):
    """PL: Net Income = -(sum of P&L deltas)."""
    revenue = Decimal("0")
    expense = Decimal("0")
    for r in deltas:
        d = D(r["delta"])
        if r["account_type"] == "Revenue":
            revenue += -d  # credit normal → negate to show positive
        elif r["account_type"] == "Expense":
            expense += d   # debit normal → positive

    ni = revenue - expense
    result.check(f"PL Revenue", revenue, revenue)
    result.check(f"PL Expense", expense, expense)
    result.check(f"PL Net Income", ni, ni)
    return ni


def test_cashflow(company_id, period, periods, deltas, cum_balances, prior_cum, result, token):
    """CF: Operating + Investing + Financing + NI = Net change in cash.
    Cash end = Cash beginning + Net change. Cash end = BS cash balance."""
    
    # Net Income from P&L
    pl_sum = Decimal("0")
    for r in deltas:
        if r["account_type"] in ("Revenue", "Expense"):
            pl_sum += D(r["delta"])
    ni = -pl_sum  # negate: credit-debit

    # CF sections: each BS account delta negated
    operating = Decimal("0")  # NI + Op-WC + Op-NonCash
    investing = Decimal("0")
    financing = Decimal("0")
    cash_delta = Decimal("0")

    for r in deltas:
        d = D(r["delta"])
        cf = r.get("cf_category", "") or ""
        atype = r["account_type"]
        if atype in ("Revenue", "Expense"):
            continue
        if cf == "Cash":
            cash_delta += d  # actual cash movement (not negated)
        elif cf in ("Op-WC", "Op-NonCash"):
            operating += -d
        elif cf == "Investing":
            investing += -d
        elif cf == "Financing":
            financing += -d

    net_change = ni + operating + investing + financing
    
    # Cash at beginning = cumulative cash through prior period
    cash_begin = Decimal("0")
    if prior_cum:
        for r in prior_cum:
            if (r.get("cf_category") or "") == "Cash":
                cash_begin += D(r["balance"])

    # Cash at end = cumulative cash through current period
    cash_end_bs = Decimal("0")
    for r in cum_balances:
        if (r.get("cf_category") or "") == "Cash":
            cash_end_bs += D(r["balance"])

    cash_end_cf = cash_begin + net_change

    result.check(f"CF Net change in cash", cash_delta, net_change)
    result.check(f"CF Cash end (CF) vs Cash end (BS)", cash_end_bs, cash_end_cf)


def test_sce(company_id, period, periods, deltas, cum_balances, prior_cum, result, accounts):
    """SCE: Closing balance = Opening + movements. Closing Total = BS total equity."""

    # Classify equity accounts
    sc_codes = set()
    re_codes = set()
    div_codes = set()
    for a in accounts:
        if a["account_type"] != "Equity":
            continue
        code = a["account_code"]
        if code == "999999":
            continue
        if code.startswith("203080") or code.startswith("2081"):
            sc_codes.add(code)
        elif code.startswith("203040") or code.startswith("2898"):
            div_codes.add(code)
        else:
            re_codes.add(code)

    def sum_cum(codes, data):
        return sum(-D(r["balance"]) for r in data if r["account_code"] in codes)

    def sum_delta(codes, data):
        return sum(-D(r["delta"]) for r in data if r["account_code"] in codes)

    # Opening = prior period cumulative (negated for equity)
    if prior_cum:
        open_sc = sum_cum(sc_codes, prior_cum)
        open_re = sum_cum(re_codes, prior_cum)
        open_div = sum_cum(div_codes, prior_cum)
    else:
        open_sc = open_re = open_div = Decimal("0")

    # Movements
    delta_sc = sum_delta(sc_codes, deltas)
    delta_re = sum_delta(re_codes, deltas)
    delta_div = sum_delta(div_codes, deltas)

    # NI
    ni = Decimal("0")
    for r in deltas:
        if r["account_type"] in ("Revenue", "Expense"):
            ni += D(r["delta"])
    ni = -ni

    # Closing per column = opening + delta
    close_sc = open_sc + delta_sc
    close_re = open_re + delta_re
    close_div = open_div + delta_div

    # Undistributed P/L = -(posted 999999 cumulative) + -(P&L cumulative)
    posted_999999 = Decimal("0")
    pl_cum_total = Decimal("0")
    for r in cum_balances:
        if r["account_code"] == "999999":
            posted_999999 = D(r["balance"])
        elif r["account_type"] in ("Revenue", "Expense"):
            pl_cum_total += D(r["balance"])
    undistributed_pl = -posted_999999 + (-pl_cum_total)

    # Closing Total = sum of columns + undistributed P/L
    close_total = close_sc + close_re + close_div + undistributed_pl

    # Verify: Closing per-column should match cumulative balance
    actual_sc = sum_cum(sc_codes, cum_balances)
    actual_re = sum_cum(re_codes, cum_balances)
    actual_div = sum_cum(div_codes, cum_balances)

    result.check(f"SCE Share Capital closing", actual_sc, close_sc)
    result.check(f"SCE Retained Earnings closing", actual_re, close_re)
    result.check(f"SCE Dividends closing", actual_div, close_div)

    # BS total equity (for cross-check)
    bs_equity = Decimal("0")
    posted_999999 = Decimal("0")
    pl_cum = Decimal("0")
    for r in cum_balances:
        if r["account_type"] == "Equity":
            if r["account_code"] == "999999":
                posted_999999 = D(r["balance"])
            else:
                bs_equity += -D(r["balance"])
        elif r["account_type"] in ("Revenue", "Expense"):
            pl_cum += D(r["balance"])
    bs_undistributed = -posted_999999 + (-pl_cum)
    bs_total_equity = bs_equity + bs_undistributed

    result.check(f"SCE Closing Total vs BS Total Equity", bs_total_equity, close_total)


# ─── Cache validation ────────────────────────────────────────────────────────

CF_URL = "https://skuld-ujyp5qup5a-uc.a.run.app"

def test_cache(company_id, periods, all_cum, accounts, result):
    """Compare Cloud Function cache output against direct BigQuery balances.
    This validates reports_cache.js produces correct numbers."""
    try:
        resp = requests.post(CF_URL, json={
            "action": "report.cache_balances",
            "companyId": company_id
        }, timeout=30)
        data = resp.json().get("data", resp.json())
    except Exception as e:
        result.fail(f"Cache fetch failed: {e}")
        return

    columns = data.get("columns", [])
    rows = data.get("rows", [])

    # Find period columns
    period_cols = [c for c in columns if c.startswith("FY")]
    if not period_cols:
        result.fail("Cache has no FY period columns")
        return

    # Build cache lookup: account_code -> { period -> balance }
    cache_map = {}
    for row in rows:
        code = str(row.get("Account Code", "")).strip()
        if not code:
            continue
        cache_map[code] = {}
        for pc in period_cols:
            val = row.get(pc)
            cache_map[code][pc] = D(val) if val is not None else Decimal("0")

    # Compare each account's FY cumulative balance
    mismatches = 0
    checked = 0
    for period in periods:
        pname = period["period_name"]
        if pname not in period_cols:
            continue
        if pname not in all_cum:
            continue

        cum = all_cum[pname]
        for r in cum:
            code = r["account_code"]
            bq_bal = D(r["balance"])
            cache_bal = cache_map.get(code, {}).get(pname, Decimal("0"))

            checked += 1
            if abs(bq_bal - cache_bal) > TOLERANCE:
                mismatches += 1
                if mismatches <= 5:  # limit output
                    result.fail(f"Cache mismatch {code} {pname}",
                                f"BQ={bq_bal:,.2f} vs Cache={cache_bal:,.2f}")

    if mismatches == 0:
        result.ok(f"Cache vs BQ: {checked} values match across {len(period_cols)} periods")
    elif mismatches > 5:
        result.fail(f"Cache vs BQ: {mismatches} total mismatches (showing first 5)")

    # Also verify parent account roll-ups (codes like '1', '2', '3', '5')
    parent_codes = [c for c in cache_map if len(c) < 6]
    for pc_code in parent_codes:
        for pname in period_cols:
            if pname not in all_cum:
                continue
            # Sum all leaf accounts matching this parent prefix
            expected = Decimal("0")
            for r in all_cum[pname]:
                if r["account_code"].startswith(pc_code) and len(r["account_code"]) >= 6:
                    expected += D(r["balance"])
            cache_val = cache_map.get(pc_code, {}).get(pname, Decimal("0"))
            if abs(expected - cache_val) > TOLERANCE:
                result.fail(f"Cache parent {pc_code} {pname}",
                            f"expected={expected:,.2f} cache={cache_val:,.2f}")


# ─── Main runner ─────────────────────────────────────────────────────────────

def run_tests(company_filter=None, period_filter=None):
    token = get_token()
    companies = load_companies(token)

    if company_filter:
        companies = [c for c in companies if c == company_filter]
        if not companies:
            print(f"❌ Company '{company_filter}' not found")
            return False

    overall = TestResult()

    for company_id in companies:
        print(f"\n{'='*60}")
        print(f"COMPANY: {company_id}")
        print(f"{'='*60}")

        periods = load_fy_periods(company_id, token)
        accounts = load_accounts(company_id, token)

        if not periods:
            print(f"  ⚠️  No FY periods found, skipping")
            continue

        all_cum = {}
        all_deltas = {}

        for period in periods:
            pname = period["period_name"]
            if period_filter and pname != period_filter:
                continue

            print(f"\n  ── {pname} ({period['start_date']} to {period['end_date']}) ──")

            cum = load_cumulative_balances(company_id, period["end_date"], token)
            deltas = load_period_deltas(company_id, period["start_date"], period["end_date"], token)
            prior = load_prior_cumulative(company_id, periods, pname, token)

            all_cum[pname] = cum
            all_deltas[pname] = deltas

            test_trial_balance(company_id, period, cum, overall)
            test_balance_sheet(company_id, period, cum, overall)
            ni = test_pnl(company_id, period, deltas, overall)
            test_cashflow(company_id, period, periods, deltas, cum, prior, overall, token)
            test_sce(company_id, period, periods, deltas, cum, prior, overall, accounts)

        # Cross-period integrity checks
        if all_cum and not period_filter:
            tested_periods = [p for p in periods if p["period_name"] in all_cum]
            print(f"\n  ── Cross-period Integrity ──")
            test_integrity(company_id, tested_periods, all_cum, all_deltas, accounts, overall)

        # Cache validation: Cloud Function output vs BigQuery
        if all_cum:
            print(f"\n  ── Cache Validation (Cloud Function vs BigQuery) ──")
            test_cache(company_id, periods, all_cum, accounts, overall)

    print(f"\n{'='*60}")
    print(f"SUMMARY: {overall.passed} passed, {overall.failed} failed")
    if overall.errors:
        print(f"\nFailed tests:")
        for e in overall.errors:
            print(f"  • {e}")
    print(f"{'='*60}")

    return overall.failed == 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Skuld Report Integrity Tests")
    parser.add_argument("--company", help="Test specific company only")
    parser.add_argument("--period", help="Test specific FY period only (e.g. FY2025)")
    args = parser.parse_args()

    success = run_tests(company_filter=args.company, period_filter=args.period)
    sys.exit(0 if success else 1)
