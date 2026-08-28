# AP Aging Drill-Through Spec

Status: **DRAFT — proposal, not yet ratified.** Companions: `fb-list-ux-spec.md` (tree mode, §6.1; the machine this spec builds on), `payables-ux-spec.md` (Bills tree-table precedent). Raised alongside the FB.list default-period work — AP Aging is the intended "reach any open bill regardless of period" escape hatch once Bills defaults to the current ledger period, and it needs to actually go somewhere for that to hold.

---

## 1. Purpose

Give AP Aging a real drill-through into the bill it's showing, instead of no interactivity at all. This closes a gap the current implementation has, and it's a precondition for a separate, already-agreed decision: Bills' default view can stay a clean, unconditional "current ledger period" (no status-OR-date special-casing) *only if* AP Aging is a complete path to any open bill regardless of age — view **and** act, not just view.

## 2. Current state (corrected — read before implementing)

Two things exist under the "AP Aging" name; only one is live.

- **`api/src/pages/ap-aging.js` (`handleApAgingPage`) is dead code.** Imported in `reports.js` but never mounted to a route. Its partner-grouped table + read-only bill-preview modal are unreachable — not what anyone sees today.
- **The live report is `buildAPAging()` in `reports/render.js` (~L981–L1112)**, served by `/api/:company/report?type=ap-aging` and loaded into `<iframe id="report-frame">` by `reports-hub.js` (`/:company/reports?t=ap-aging`). Old `/:company/payables/aging` bookmarks 302 here.
- Live behavior: `tr.vendor-row` click → `toggleDetail(this)`, a bespoke expand/collapse of a nested `<table>`. Individual `tr.detail-row` bill lines are **static** — no click handler, no href, no way to reach the underlying bill at all.
- Row data comes from `bill.aging` (not `bill.list`), already carrying `bill_id`, `partner_name`, `date`, `vendor_ref`, `bucket`, `balance_due` per bill — the data needed for drill-through is already in hand, just not wired to anything.

## 3. Precedent to reuse, not reinvent

`buildVoucherRegister()`, same file (~L576–L810), already solves "read-only register embedded in a report iframe, rows drill out to a real page":

- Rows render via `FB.list.create({ canAdd: false, editable: () => false, same: () => true, validate: () => null, ... })` — read-only FB.list, not a bespoke table.
- After `vrList.load()`, each `<tr data-key>` gets a computed `data-href` (via a `drillHref(row)` helper) and two listeners — `keydown` (Enter) and `click` — that do `window.parent.location.href = tr.getAttribute('data-href')`, breaking out of the iframe to the top-level page.
- `drillHref` appends `from=voucher-register` plus the report's `rpt_start`/`rpt_end` as return-context.
- The target page (`journal-voucher.js`) reads `from`/`rpt_start`/`rpt_end` via `URLSearchParams` and its quit (`q`) handler rebuilds `/${COMPANY}/reports?t=${FROM_REPORT}&start=${RPT_START}&end=${RPT_END}` on the way out.

AP Aging should be built the same way, not a parallel mechanism.

## 4. Decision: rebuild `buildAPAging` on `FB.list` tree mode

Vendor → bills is a two-level parent/child structure — the same shape Bills already uses (`fb-list-ux-spec.md` §6.1), and a better fit than Voucher Register's flat list.

**Verified against `api/public/fb-list.js` source, not just the doc:** `children`, `foldKey`, and `childRowHtml` all exist as real config hooks (defaulting/init ~L154–166; consumed at rendering ~L808–812 and edit-entry ~L1002–1007). Not aspirational.

**How child rows actually render (verified, not assumed):** it's neither a nested `<table>` nor colgroup-driven auto-alignment. `rowHtml()` puts child rows as genuine sibling `<tr>`s in the *same* `<tbody>` as parents — one shared table:

```js
if (cfg.tree && d._childOf) {
  var inner = cfg.childRowHtml ? cfg.childRowHtml(parent, d, i) : '';
  return '<tr data-idx="..." data-child-of="...">' + inner + '</tr>';
}
```

The framework owns the `<tr>` shell (nav index, dirty class, `data-child-of`); `childRowHtml` supplies the inner `<td>`s directly. There is **no framework-level check** that the `<td>` count/order matches the parent's `columns[]` — that's on this implementation to get right. Once it does, alignment is free (same table, normal table layout, no colgroup to keep in sync). One asymmetry to account for: the fold caret prepended to a parent's first cell (`cfg.tree && ci === 0` branch, ~L819) only fires in the non-child code path — child rows get no automatic indent/caret. If bill rows want a visual nesting cue, `childRowHtml` adds it itself (e.g. `padding-left` on its first `<td>`).

Worth flagging honestly: Bills' own reference use of `childRowHtml` (bill header vs. expense line) has parent and child with *entirely different* columns. AP Aging's case — same six bucket columns on both levels, child populates one and blanks the rest — is a different usage of the same primitive, not a repeat of an established pattern. Supported by the source; just not precedented in exactly this shape.

```
FB.list.create({
  tree: true,
  canAdd: false,
  editable: function () { return false; },
  deletable: function () { return false; },
  same: function () { return true; },
  validate: function () { return null; },
  children: function (vendorRow) { return vendorRow._bills; },   // already grouped client-side, no lazy fetch needed
  foldKey: function (row) { return row._key; },                  // default-folded, per §6.1 — matches current "collapsed by default" behavior
  columns: [ /* Current / 1–30 / 31–60 / 61–90 / 90+ / Total — parent (vendor) totals; childRowHtml below must emit one <td> per entry, same order */ ],
  childRowHtml: function (parent, bill, idx) {
    // Must emit exactly cfg.columns.length <td>s, same order as parent —
    // no framework enforcement, verify by inspection. One bucket column
    // populated per bill, rest blank; mirrors today's detail-row.
  },
  ...
})
```

This replaces `toggleDetail()` with the framework's native fold — vendor-row click/`Space` expands/collapses, same as any other FB.list tree screen. No bespoke expand/collapse code to maintain.

## 5. Drill-through wiring (bill rows only)

Vendor (parent) rows keep fold semantics — click/`Space` toggles, does **not** navigate. Bill (child) rows get the `data-href` + `window.parent.location.href` treatment from §3, wired after load exactly as Voucher Register does it — same listener shape, same breakout call.

**Target URL** (using the *current* route, not Voucher Register's stale one — see §7):

```
/${COMPANY}/bill/${encodeURIComponent(bill_id)}?from=ap-aging&asof=${encodeURIComponent(AS_OF)}
```

Append `&ccy=${encodeURIComponent(currencyFilter)}` when a currency filter is active on the report, so it round-trips too.

Note the shape difference from Voucher Register's `rpt_start`/`rpt_end`: AP Aging is `needsStart: false` (`report-registry.js`) — it's an as-of snapshot, not a date range. One param, `asof`, not two. Named `asof` deliberately rather than reusing Reports Hub's `end` — see §6 for where it gets mapped.

`window.parent.location.href` assumes the report is embedded in an iframe. If AP Aging is ever loaded outside `reports-hub.js`, `window.parent === window` and the assignment is still correct — no special-casing needed either way.

## 6. Return path

**`bill-detail.js`** — extend the existing `escape` handler (`fbKeyActions.escape`, currently a hardcoded `fbNavigate('/' + COMPANY + '/payables')`):

```js
'escape': function () {
  var params = new URLSearchParams(window.location.search);
  var from = params.get('from');
  if (from === 'ap-aging') {
    var asof = params.get('asof') || '';
    var ccy  = params.get('ccy') || '';
    // asof= (not end=) on the outbound URL by design — see §3 rationale.
    // Mapped to reports-hub's end= param at the destination, not here.
    var url = '/' + COMPANY + '/reports?t=ap-aging&end=' + encodeURIComponent(asof);
    if (ccy) url += '&ccy=' + encodeURIComponent(ccy);
    fbNavigate(url);
    return;
  }
  if (typeof COMPANY !== 'undefined') fbNavigate('/' + COMPANY + '/payables');
}
```

Same shape as `journal-voucher.js`'s `q` handler — read `from` first, branch, otherwise fall through to current behavior unchanged.

**`reports-hub.js` — needs a new branch, placed *ahead of* the existing one.** The current period-restore logic only fires when *both* `startParam` and `endParam` are present:

```js
} else if (startParam && endParam) {
  // Restore period from ?start=&end= ...
} else if (periods.length) {
  // fetch default-period
}
```

AP Aging returns with `end=` only (`needsStart: false` — there's no `start` to send), so as written this falls through to the *default-period* branch, silently discarding the specific as-of date in favor of the ledger-anchored default.

Checked two things before deciding where the new branch goes:
- `#rpt-start` (`reports-hub.js` L53) is a single, **always-rendered** input — never conditionally removed for `needsStart:false` types — so the existing branch wouldn't throw on a missing element if it fired for AP Aging.
- `buildReportUrl()` (~L293) already ignores `start` entirely for `needsStart:false` types, so even if the existing branch fired on a stale AP-Aging bookmark carrying both params, it wouldn't actually mis-load the report — just harmlessly set a value on an input the URL builder never reads for this type.

So the existing branch firing for AP Aging isn't the throw/misfire risk it initially looked like. Doesn't change the recommendation, though — placing the new branch first is simpler and makes "explicit return-context wins" true unconditionally, rather than correct-by-coincidence because of how `buildReportUrl()` happens to behave today:

```js
} else if (endParam && RPT_META[currentType] && !RPT_META[currentType].needsStart) {
  document.getElementById('rpt-end').value = endParam;
  periodLoaded = true;
  if (drillThrough) fbLoadReport();
} else if (startParam && endParam) {
  // existing range-restore path, now only reachable by needsStart:true types
  ...
} else if (periods.length) {
  // fetch default-period
}
```

## 7. Companion fix (same file, same bug class — do alongside, not instead of)

`drillHref()` in `buildVoucherRegister` (reports/render.js ~L731) builds bill-sourced links as:

```
/${COMPANY}/payables/bill/${id}?from=voucher-register...
```

`/:company/payables/bill/:id` isn't a registered route — only `/:company/bill/:id` is, since the 2026-08-11 Payables→Bills rename. Voucher Register's drill-through into a bill is currently broken. One-line fix: `/payables/bill/` → `/bill/`. Ship in the **same PR, separate commit** — it's a pre-existing bug, not new scope, and keeps `git blame` honest about which change introduced what. Same reasoning applies to any other pre-existing issue surfaced incidentally while doing this work.

## 8. Non-goals (v1)

- **Vendor fold-state round-trip.** Returning from a bill doesn't need to restore which vendors were expanded — re-arrives fully folded, same as any fresh AP Aging load. Cheap to add later if it's missed in practice; not blocking.
- **Grammar/filter-expression parity with FB.list's box-expr.** AP Aging's only inputs are as-of date + currency — no need to route these through the shared `date:`/`amount:` qualifier grammar §8 of `fb-list-ux-spec.md` describes; two plain URL params are sufficient here.

## 9. Testing contract

Mirrors `fb-list-ux-spec.md` §12 — live browser verification of the cycle, not pixel tests:

1. Load AP Aging with at least one vendor with 2+ open bills across different buckets.
2. Fold/unfold a vendor row — confirm native FB.list tree fold (no `toggleDetail` remnants).
3. Click a bill row → lands on `/${COMPANY}/bill/${id}`, correct bill loaded.
4. Escape from that bill → lands back on AP Aging, same as-of date and currency filter as before drill-in (not the ledger-default period).
5. Same cycle via keyboard only (Enter to drill in, `Escape` to return) — mouse parity isn't sufficient on its own, per this app's keyboard-first convention.
6. Companion check: from Voucher Register, drill into a bill-sourced journal entry — confirm it now lands on `/bill/:id` instead of 404ing.
7. A vendor with exactly one open bill — confirm single-child fold/unfold and drill-through both behave the same as the multi-bill case (no off-by-one in the flattened parent+children sequence).
8. A `status: 'partial'` bill whose computed `balance_due` is `0` (data-consistency edge case, not the common path — `getAgingReport()` filters by `status IN ('posted','partial')`, not by `balance_due > 0`, so this can theoretically surface a row). Confirm it either doesn't appear, or if it does, that drilling into it doesn't present as an actionable open balance when the bill is effectively settled.
