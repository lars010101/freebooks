# FB.list Bills Return-Context Spec

Status: **DRAFT — proposal, not yet ratified.** Companion: `fb-list-default-period-spec.md` (item 2 — this spec closes the seam explicitly left open at its §7/§9), `ap-aging-drilldown-spec.md` (the proven precedent this reuses — same mechanism, already implemented and confirmed live, originally in `bill-detail.js`).

**Note (2026-09-06):** `bill-detail.js` has since been merged into `bill-edit.js` (its old `fbKeyActions.escape` handler is now `bill-edit.js`'s `quitEditor()`/`returnUrl()`, a plain function rather than a legacy-dispatcher entry). This spec's proposal is otherwise unaffected — the `ap-aging` branch it reuses as precedent moved with it intact, and the `bills` branch this spec proposes would now be added to `returnUrl()` instead. Code snippets below still show the pre-merge `fbKeyActions.escape` shape; the underlying `if (from === 'ap-aging') {...} else {...}` branching logic they describe carried over unchanged into `returnUrl()`, just no longer wrapped in that object.

---

## 1. Purpose

Item 2 gives Bills a real, adjustable date-range scope. Without this spec, that scope doesn't survive a round trip through `bill-detail.js`: open a bill, hit Escape, land back on Bills with the range silently reset to the computed default — exactly the loss item 2's own §7 return-context check was built to prevent, just missing the half that actually produces the param. This spec is that missing half, for one specific, already-identified path — not a general return-context framework for every FB.list screen.

## 2. Current state, verified against the live code (not the earlier snapshot)

Two things, checked directly in the just-pulled repo:

- **The "into" direction has no context at all.** `payables-bills.js` L1342, the `vendor_ref` column's `display()`:

```js
return '<a href="/' + esc(COMPANY) + '/bill/' + esc(id) + '" class="ref-link" onclick="event.stopPropagation()">' + esc(v || '') + '</a>';
```

A bare link — bill ID only, no `from=`, no date range. This is the Bills list's row-level "view full record" affordance, distinct from `i`/Enter's inline tree-edit (fb-list-ux-spec.md §4) — the two exist side by side, this one navigates to a separate page.

- **The "out" direction already has the shape to extend, not build from scratch.** `bill-detail.js` ~L373–387 (confirmed live, matches `ap-aging-drilldown-spec.md` §6 as implemented):

```js
'escape': function () {
  var params = new URLSearchParams(window.location.search);
  var from = params.get('from');
  if (from === 'ap-aging') {
    var asof = params.get('asof') || '';
    var ccy  = params.get('ccy') || '';
    var url = '/' + COMPANY + '/reports?t=ap-aging&end=' + encodeURIComponent(asof);
    if (ccy) url += '&ccy=' + encodeURIComponent(ccy);
    fbNavigate(url);
    return;
  }
  if (typeof COMPANY !== 'undefined') fbNavigate('/' + COMPANY + '/payables');
}
```

Anything besides `from=ap-aging` — including today, every bill opened from the Bills list — falls through to the hardcoded fallback. This spec adds a sibling branch, same shape as the existing one, not a rewrite.

## 3. Param naming — `dateFrom`/`dateTo`, matching item 2's body params exactly

Item 2 originally floated `?periodStart=&periodEnd=` as an illustrative placeholder for this exact seam. Finalizing it here as `dateFrom`/`dateTo` instead — the same names item 2 already uses for the `bill.list` request body (`fb-list-default-period-spec.md` §5) — rather than introducing a third name for the same value as it moves from URL param to request body. One name, one meaning, everywhere it appears. Item 2's §7 has been updated to match (no longer says "e.g.").

## 4. The "into" direction: the ref-link carries the active range

**Read the same two elements `list.body()` already reads, the same way — no getter, no abstraction.** An earlier version of this spec proposed a `getActiveDateRange()` getter; checked against the real item 2 implementation and it doesn't exist, and shouldn't — `list.body()` (`payables-bills.js` L1377–1385) reads `document.getElementById('bill-date-from')`/`('bill-date-to')` inline, and this is the same two elements, same page, same lifetime. Introducing an abstraction for one of the two callers while the other reads directly would be the inconsistency, not the fix for one — this codebase doesn't wrap simple DOM reads elsewhere either.

**Both-or-neither, matching the consuming side exactly** — see §5: `initBillDateRange()`'s restore check is `if (ps && pe)`, both required. Appending the two params independently could produce a URL with only one set (if a user clears one date input but not the other before clicking through), which the consuming side would then silently treat as absent and fall back to the computed default. Guarding here to match, not just defensively:

```js
{ field: 'vendor_ref', type: 'text', filterType: 'text',
  display: function (v, r) {
    var id = String(r.bill_id || r._key || '');
    var qs = 'from=bills';
    var df = document.getElementById('bill-date-from');
    var dt = document.getElementById('bill-date-to');
    if (df && df.value && dt && dt.value) {
      qs += '&dateFrom=' + encodeURIComponent(df.value) + '&dateTo=' + encodeURIComponent(dt.value);
    }
    return '<a href="/' + esc(COMPANY) + '/bill/' + esc(id) + '?' + qs + '" class="ref-link" onclick="event.stopPropagation()">' + esc(v || '') + '</a>';
  } }
```

## 5. The "out" direction: one new branch in the existing handler

```js
'escape': function () {
  var params = new URLSearchParams(window.location.search);
  var from = params.get('from');
  if (from === 'ap-aging') {
    ... // unchanged
  }
  if (from === 'bills') {
    var dateFrom = params.get('dateFrom') || '';
    var dateTo   = params.get('dateTo') || '';
    var qs = [];
    if (dateFrom && dateTo) {
      qs.push('dateFrom=' + encodeURIComponent(dateFrom), 'dateTo=' + encodeURIComponent(dateTo));
    }
    fbNavigate('/' + COMPANY + '/bills' + (qs.length ? '?' + qs.join('&') : ''));
    return;
  }
  if (typeof COMPANY !== 'undefined') fbNavigate('/' + COMPANY + '/payables');
}
```

**The consuming side is not new work — it's already built.** An earlier version of this spec sketched a `setActiveDateRange()` + `billsList.load()` pseudocode for "the page-load resolution, shown for completeness." Checked against the real item 2 implementation: no such function exists, and nothing here needs writing. `initBillDateRange()` (`payables-bills.js` L313–337) already does exactly this, and its own header comment names this spec by number:

```js
// Resolves the bill list date range before the first load:
//   1. ?dateFrom=/?dateTo= URL params (return-context seam for future
//      item 4 — drill-through from reports/bill detail back to this list)
//   2. /api/:company/reports/default-period (latest posted-transaction period)
//   3. No periods configured → setup-state spanning row (bill.list not called)
function initBillDateRange() {
  var params = new URLSearchParams(window.location.search);
  var ps = params.get('dateFrom'), pe = params.get('dateTo');
  var fromEl = document.getElementById('bill-date-from');
  var toEl = document.getElementById('bill-date-to');
  if (ps && pe) {
    if (fromEl) fromEl.value = ps;
    if (toEl) toEl.value = pe;
    billsList.load();
    return;
  }
  fetch('/api/' + COMPANY + '/reports/default-period') /* ... item 2 §7 resolution, unchanged */
}
```

So this spec's actual remaining scope is narrower than earlier drafts stated: **§4 and this section's escape-handler branch — full stop.** Nothing on the Bills-list load-resolution side needs to change; it was written anticipating this exact producer, params and all.

## 6. Observation, not a fix: no confirmed keyboard path to `bill-detail.js` from the Bills list

Worth flagging, not addressing here — out of this spec's scope, which is preserving context on an *existing* navigation, not adding a new one. The ref-link is a plain `<a>` with `stopPropagation()` on click, specifically to avoid colliding with the row's own click-to-inline-edit behavior. `i`/Enter on a focused Bills row triggers inline tree edit (`fb-list-ux-spec.md` §4), not navigation to `bill-detail.js` — meaning there may be no keyboard-only path to this page from the Bills list at all, only a mouse click on the reference-number text. Given this app's stated keyboard-first, mouse-parity design philosophy, that's either intentional (inline edit is the primary keyboard path; `bill-detail.js` is deliberately a secondary, mouse-oriented "full record" view) or an oversight nobody's caught yet. Worth someone confirming which, separately from this work.

## 7. Non-goals

- **Tree-fold state.** Which bills were expanded on the Bills list before drilling in — not restored on return. Same reasoning as the AP-Aging spec's equivalent non-goal: re-arrives fully folded, cheap to add later if it's missed in practice.
- **Scroll position.** Not preserved.
- **The keyboard-reachability question in §6.** Flagged, not fixed here.
- **Any other FB.list screen's return-context.** This is Bills ↔ `bill-detail.js` specifically, the one path item 2 identified as open. Not a general "add return-context to every FB.list drill-through" framework — three one-off instances (Reports↔JV, AP-Aging↔bill, now Bills↔bill) is not yet a pattern that's earned a shared abstraction; revisit if a fourth comes up looking the same.

## 8. Testing contract

Mirrors `ap-aging-drilldown-spec.md` §9 in shape, since this reuses its mechanism directly.

1. Adjust Bills' date range away from the computed default. Click a bill's reference-number link: confirm the resulting URL carries `dateFrom`/`dateTo` matching the *adjusted* range, not the original default.
2. From that bill, Escape: confirm landing back on `/${COMPANY}/bills` with the exact same range restored — not a re-fetch of the default-period endpoint, not empty.
3. Navigate to a bill via a direct link with no `from=` param at all (e.g. a bookmark, or a link from somewhere else entirely): confirm Escape falls through to the existing unchanged fallback — this branch must not swallow cases it doesn't own.
4. In one session, open a bill from AP Aging and confirm Escape still returns there correctly (§5's new branch must not regress the existing `from === 'ap-aging'` branch); separately, open a bill from Bills and confirm it returns to Bills — no cross-contamination between the two `from` values.
5. Confirm the ref-link's `stopPropagation()` still prevents the click from also triggering the row's inline-edit path — this spec touches the same `display()` function and shouldn't disturb that.
6. Clear one date input (leave the other set), then click a bill's reference-number link: confirm the URL carries neither `dateFrom` nor `dateTo` (§4's both-or-neither guard), and confirm `initBillDateRange()`'s own `if (ps && pe)` check means Escape from that bill falls through to the default-period fetch gracefully — not a half-applied range, not an error.
