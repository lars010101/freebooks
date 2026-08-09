# `:show` Command Spec

**Status:** Draft v3 — architecture settled after review; not yet implemented.
**Supersedes:** v1 and v2 of this spec (both scrapped — see §1). Also supersedes the plain `:report` alias.
**Depends on:** `action-catalog.js` (`palette: 'navigate'` entries), `report-registry.js`, and the existing palette component in `fb-core.js` (`_catalog`, `_match`, `_render`, `_detectGrammar`).
**Context:** single-user, self-hosted, one operator — but per this revision, `:show` is explicitly also the app's answer to "I don't remember where things live," not just a speed tool. That's a second, real requirement alongside round-trip speed, not a contradiction of it.

---

## 0. Why this exists

Issue **#149** dropped NAV rows from the `:` palette, scoping it to "aliased + key-less API commands," and pushed navigation teaching to the `?` overlay. But `?`'s NAV section only covers sidebar routes with a `gKey` — tab-level destinations (Opening Balances, VAT codes, etc.) aren't in `?` either. So there is currently **no surface anywhere** — not `:`, not `?` — that teaches a newcomer the full set of places they can go. That's the gap `:show` closes, and it's why "scaffolding" is a real requirement, not scope creep.

---

## 1. What changed from v1/v2, and why

v1 built `:show` as a typed alias in `fb-command.js` reading from two hand-injected globals (`window.FB_ROUTES` with a `tabs` array, `window.FB_REPORT_IDS`). Review caught this correctly: it's a **parallel resolution system** sitting beside the action catalog — the exact thing the `:new` → `PALETTE` navigate-entries cutover (`91b2d1a`) had already established shouldn't happen. v2 tried to fix the symptom (hardcoded table → registry-derived table) without fixing the root cause (a second alias-and-parser layer duplicating what the catalog already does).

The actual fix, worked out across this conversation:

1. **Split by argument shape, not by "screens vs. reports."** Zero-argument navigation (screens, tabs) fits the `:new` pattern exactly — dissolve into `PALETTE` navigate entries, no alias, no parser. Reports take an optional second argument (period), which a flat catalog entry can't express.
2. **Checking the real catalog showed the "screens" gap was almost entirely already closed.** `coa.upsert`, `partner.upsert`, `period.upsert`, `fx.provider.save`, `settings.save` are already plain-navigate entries. Only 3–4 entries were actually missing (§2).
3. **The scaffolding requirement means `:show` still needs to exist** — but as a **third mode of the palette component itself**, not a typed-grammar alias. It filters and groups data the catalog already has; it doesn't own or duplicate any of it.
4. **Reports need exactly one new piece of state** — id→label pairs, so a browse view can say "Profit & Loss" instead of `pl`. That's sourced as a thin projection of `report-registry.js`, fetched the same way `_catalog` is already fetched — not a hand-maintained list, not a sync-injected global bolted onto `navBar()`.

Net effect: **no new alias, no new parser, no `fb-command.js` changes at all.** Everything lives in `action-catalog.js` (a few entries), one small new read endpoint (report metadata), and `fb-core.js` (a third palette mode).

---

## 2. Screens/tabs: the actual gap

Verified against the live `action-catalog.js`, not assumed. Already-reachable today (no change needed): Chart of Accounts, Partners, Periods, Exchange Rates, bare Settings. Missing:

| New entry | Route | Note |
|---|---|---|
| `vat.codes.view` *(new key)* | `/settings?tab=vat` | only the `&new=1` create-shortcut exists today (`vat.codes.upsert`) |
| `journals.view` *(new key)* | `/settings?tab=journals` | same — only `journals.save`'s create-shortcut exists |
| `ai.view` *(new key)* | `/settings?tab=ai` | no entry at all today |
| `openingBalance.view` *(new key, no backing action)* | `/settings?tab=opening-balances` | no entry at all today, and no existing action to attach to — every other navigate entry piggybacks on a real action; this one doesn't |

That last row is worth a decision, not just a note: either add a synthetic view-only catalog entry (fine, precedented enough by `settings.save`/`company.save` which are also fairly thin), or decide Opening Balances should get a real lightweight action behind it for consistency. Either way, four entries, no new architecture.

---

## 3. Reports: one new endpoint, not a new global

`report-registry.js` already has human labels (used to build `RPT_META` inline in `reports-hub.js`). For the palette (global chrome, not page-local) to show "Profit & Loss" instead of `pl`, that data needs to be reachable from anywhere, the same way `_catalog` already is.

**Add `GET /api/:company/reports/registry` → `[{ id, label }, ...]`**, generated directly from `REPORT_REGISTRY` — the same data `reports-hub.js` already serializes into `RPT_META`, just also exposed as a lightweight endpoint. This is a projection, not a duplicate: there is exactly one place report metadata is authored (`report-registry.js`), and two places it's read (`reports-hub.js`'s inline `RPT_META`, and this new endpoint).

Fetched once by the palette component, alongside the existing `_catalog` fetch, with the same graceful-degradation stance the code already documents for `_catalog` (*"palette works page-verbs-only without it"*) — if this fetch is slow or fails, `:show` still works for screens/tabs, it just doesn't show reports until it resolves.

This was originally going to be a sync `window.FB_REPORTS` global injected via `navBar()`, matching how `window.FB_ROUTES` works. Switched to an async fetch instead because it's more consistent with how the palette already sources supplementary data (`_catalog` is fetched, not injected) — one pattern for "data the palette needs but doesn't own," not two.

---

## 4. The palette's third mode

The palette already has two modes, both documented in `fb-core.js`'s own comments:

- **fuzzy mode** — bare `:` or an incomplete first token. Flat list, `_aliasCommands()` + `_apiCommands()`, ranked by recency then fuzzy score.
- **grammar mode** — first token matches a known alias + trailing space (`:bill `). Dropdown closes, a plain-text syntax hint appears, `Enter` calls `FB.command.parse()`.

`:show` needs a **third**: dropdown *stays open*, content is re-scoped (navigate-only — no `:post`, `:pay!`, or other execute actions) and grouped, and it's still live-filterable as more is typed.

### 4.1 Discovery

`:show` is registered in `FB.command.ALIASES` (so `_aliasCommands()` picks it up automatically and it's findable by typing `:sh` in ordinary fuzzy mode, same as any other alias) with a new flag distinguishing it from grammar-mode aliases:

```js
'show': { action: null, grammar: '<target> [period]', bang: false, structured: true }
```

### 4.2 Entering browse mode

The three call sites that currently do `_detectGrammar(...)` → `_showGrammarHint(g.grammar)` unconditionally need one branch: if `g.alias === 'show'` (i.e. `ALIASES.show.structured`), call a new `_showStructuredBrowse()` instead of `_showGrammarHint()`. `_showStructuredBrowse()` reuses the existing `_open()`/`_render()`/`_el` machinery — it's the same dropdown, just fed a different item list and never `_close()`d.

### 4.3 Building the item list

```js
function _navigateTargets() {
  var items = _apiCommands().filter(function (c) { return true; }); // already navigate-only + execute; need navigate-only subset
  // (in practice: filter _catalog directly for palette === 'navigate', skip the 'execute' branch)
  var groups = {};
  items.forEach(function (c) {
    var group = _groupFor(c.route); // 'Settings' | 'Payables' | 'Periods' | 'Reports' | 'Inbox'
    (groups[group] = groups[group] || []).push(c);
  });
  (_reports || []).forEach(function (r) {
    (groups['Reports'] = groups['Reports'] || []).push({
      id: 'report:' + r.id, label: r.label, group: 'Reports',
      exec: function () { window.fbNavigate('/' + _company() + '/reports?t=' + r.id); }
    });
  });
  return groups;
}

function _groupFor(route) {
  if (route.indexOf('/settings') === 0) return 'Settings';
  if (route.indexOf('/payables') === 0) return 'Payables';
  if (route.indexOf('/periods') === 0)  return 'Periods';
  if (route.indexOf('/reports') === 0)  return 'Reports';
  return 'Other';
}
```

Grouping is derived from the route prefix already on each entry — no new `category` field to hand-maintain on every catalog entry.

### 4.4 Selecting a screen/tab row

Same as any other catalog navigate entry today: click or `Enter` on the highlighted row calls `window.fbNavigate(...)` and exits command mode. No new behavior here — `:show`'s only contribution for this half is *scoping and grouping what's shown*, not changing what happens on selection.

### 4.5 Selecting a report row, and the period argument

Selecting a report row navigates immediately with no period (`/reports?t=pl`) — the reports hub already has its own period picker, so a newcomer's path ends there with zero typed syntax required.

For someone who wants to type ahead (`:show pl q2` without touching the dropdown), the tricky bit is deciding when the palette stops treating further characters as a row-filter and starts treating them as a period token — e.g. after `pl` uniquely identifies a report, does typing a space commit to that report, or keep filtering? **This is the one piece of interaction design this spec doesn't fully resolve** — flagged honestly rather than specified with false precision. The period portion should stay a thin, unvalidated pass-through regardless (`&period=<raw token>`), resolved by `reports-hub.js` the same way `?t=` drill-through already is — no client-side period parsing, no new state for that half.

### 4.6 Validation is now free

Because browse mode requires `_catalog` and the reports list to already be loaded, both halves get immediate in-bar validation as a side effect — an unrecognized target can be flagged before navigating, rather than deferred to the destination page. That's a strict improvement over the thin-`:report`-alias design from earlier in this conversation, which deliberately traded away in-bar validation to avoid a second global; here the data's being fetched anyway, so the validation is free.

### 4.7 The `journal` / `journals` collision, revisited

Flagged in v1/v2 as a typo risk in a flat single-namespace dispatch table. It mostly dissolves under grouping: typing `:show journal` in browse mode can simply show *both* "Journals" (Settings group) and "Journal Line Listing" (Reports group) as two clearly-labeled rows — ambiguity becomes a non-issue when both options are visibly distinguished rather than one silently winning a dispatch order. It only resurfaces for the blind-typed, no-dropdown-interaction case (§4.5) as a tie-break question, and only for this one pair — worth a one-line rule when that interaction is implemented, not a structural fix.

---

## 5. Migration checklist

- Add the four entries in §2 to `action-catalog.js`.
- Add `GET /api/:company/reports/registry` (§3), generated from `REPORT_REGISTRY`.
- Register `'show'` in `FB.command.ALIASES` with `structured: true` (§4.1) — no `parse()` function; it never goes through `FB.command.parse()`.
- In `fb-core.js`: branch the three `_showGrammarHint` call sites on `structured`, add `_showStructuredBrowse()`, `_navigateTargets()`, `_groupFor()`, and a `_reports` fetch alongside the existing `_catalog` fetch.
- Delete the plain `:report` alias if it still exists in `fb-command.js` — its job is fully absorbed by `:show`.
- No changes to `nav-registry.js` — the `tabs` array idea from v2 is dropped along with v2.
- Tests: palette-level coverage (not `command-parser.test.js`, since there's no parser) for: browse mode opens and stays open after `:show `, groups render correctly, a screen/tab row navigates, a report row navigates with no period, filtering narrows correctly, and the `journal`/`journals` pair both appear when ambiguous.

---

## 6. Explicitly open / out of scope

- §4.5's exact keystroke boundary between "still filtering" and "typing a period" — needs interaction-level iteration, not speccing further in the abstract.
- The `openingBalance.view` synthetic-entry-vs-real-action decision (§2).
- Refactoring `settings.js`/`payables.js` to render tab bars from a shared registry — still not needed for this; the catalog additions in §2 are independent of how the tabs render on their own pages.
