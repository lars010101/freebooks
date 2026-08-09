# `:show` Command Spec

**Status:** Draft v2 — revised after review; not yet implemented.
**Supersedes:** the bare `:report` alias (`fb-command.js` `ALIASES.report`) — deleted in the same change, with a bounded rename-hint (§6) rather than a dual-run synonym.
**Depends on:** the typed-argument grammar layer in `docs/command-bar-ux-spec.md` (tokenizer, keyword slots, `parseDate`, per-alias `parse()` returning `{ route, params, commitMode, warnings }`). That spec deferred `:report pl q2`-style shorthand pending this layer (§10); the layer now exists.
**Context:** single-user, self-hosted, one operator. Same optimization target as the command-bar spec: round-trip speed and fast re-learning after time away.

**v2 changelog:** fixes a hardcoded-vs-registry-derived asymmetry between screen and report targets (§2), a silently-dropped-argument bug on screen targets (§3), and a discoverability gap in the `:report` → `:show` cutover (§6). Closes two citation/definition gaps from v1 (inbox sourcing, `validTargetsList()`).

---

## 0. Why this exists (not just a rename)

Issue **#149** dropped NAV rows from the `:` palette entirely — reachable now only via the `?` overlay, and only for sidebar routes carrying a `gKey`. `g`-prefix motions cover only the fixed top-level set (`g i`, `g r`, `g p`, `g s`). Routes like Opening Balances (`nav-registry.js` key `opening-balances` — `sidebar:false`, `gKey:null`) have **no fast path today**: `g s`, then a mouse click on a tab.

`:show` fills that gap for every tab-level and report-level destination the `#149` cleanup and the `g`-key set don't reach. It inherits `:report`'s slot (a pure-`navigate` command under `:`, per command-bar spec §2 — `:` covers "do something," including "report," even when nothing mutates) rather than creating a new one.

---

## 1. Grammar

```
:show <target> [period]
```

Flat, single-token dispatch. `<target>` resolves against one merged lookup: screen/tab targets (§2) unioned with report ids sourced from `report-registry.js`'s `REPORT_REGISTRY` (§3). `[period]` is **only valid when `<target>` is a report** (§3.1 fixes the v1 bug where this wasn't enforced).

No `!`. This falls out of the existing dispatch generically — `parse()`'s main entry already does:

```js
if (bang && !alias.bang) return { type: 'unknown', error: ':' + verb + ' does not support !' };
```

`:show` sets `bang: false` in its `ALIASES` entry like `:report`, `:void`, `:lock` do today, so `:show! pl` is rejected by that existing check before `parseShow` ever runs — `:show! pl` → `error: ':show does not support !'`. No special-casing needed; stated here so it isn't ambiguous by omission.

---

## 2. Screen/tab targets — registry-derived, not hand-maintained

**v1 problem:** `SCREEN_ROUTES` was a hardcoded object in `fb-command.js`. Report targets auto-discover from `REPORT_REGISTRY` (`report-registry.js`'s own header comment: *"A new report = a registry entry, not a new page"*) — but a new settings tab added to `settings.js` wouldn't appear in `:show` until someone remembered to hand-edit a second, unrelated file. That's exactly the staleness risk `nav-registry.js`'s own header comment names as the reason it's a single-source registry in the first place ("Four consumers share this table so they can never drift").

**Fix: extend `nav-registry.js`, don't invent a parallel table.**

`nav-registry.js` already states its job: *"the single source of truth for app navigation... consumed by [4 things] so they can never drift."* Add a fifth. Give sidebar entries an optional `tabs` array:

```js
{ key: 'settings', route: '/:company/settings', label: 'Settings', icon: '⚙',
  sidebar: true, gKey: 's', palette: true, absolute: false,
  tabs: [
    { id: 'company',           label: 'Company' },
    { id: 'coa',                label: 'Chart of Accounts',  aliases: ['accounts'] },
    { id: 'vat',                label: 'Tax Codes' },
    { id: 'journals',           label: 'Journals',           aliases: ['books'] }, // see §5
    { id: 'fxrates',            label: 'Exchange Rates',     aliases: ['rates'] },
    { id: 'ai',                 label: 'AI' },
    { id: 'opening-balances',   label: 'Opening Balances',   aliases: ['ob'] },
  ]
},
{ key: 'payables', route: '/:company/payables', label: 'Payables', icon: '📋',
  sidebar: true, gKey: null, palette: true, absolute: false,
  tabs: [
    { id: 'bills',    label: 'Bills' },
    { id: 'partners', label: 'Partners' },
  ]
},
```

This rides the existing injection for free: `common.js`'s `navBar()` does `JSON.stringify(ROUTES)` on the *whole* array into `window.FB_ROUTES` (`common.js:121`), and `navBar()` is called on every page. Adding `tabs` to an entry means it's already present in `window.FB_ROUTES` everywhere the command bar can be invoked from — no new global, no page-local script block, no bootstrapping gap.

`fb-command.js`'s `:show` builds its screen/tab target list at parse time from `window.FB_ROUTES`:

```js
function buildScreenTargets() {
  var out = {};
  (window.FB_ROUTES || []).forEach(function (r) {
    out[r.key] = r.route.replace(':company', '').replace(/^\/*/, '/'); // e.g. '/settings'
    (r.tabs || []).forEach(function (t) {
      var route = out[r.key] + '?tab=' + t.id;
      out[t.id] = route;
      (t.aliases || []).forEach(function (a) { out[a] = route; });
    });
  });
  return out;
}
```

`settings.js` / `payables.js` still own their own tab-bar *rendering* (`showTab('coa')` onclick handlers) — this doesn't require refactoring those pages to render from the registry too, only requires the registry to be the place new tab ids get declared. **Follow-up not in scope here:** a CI check (same pattern as `tests/jurisdiction-packs.mjs`, the pack linter) that greps `settings.js`/`payables.js` for `showTab('X')`/`showPayTab('X')` calls and fails if any `X` isn't present in `nav-registry.js`'s `tabs` — that's what actually closes the drift risk end-to-end (registry says a tab exists; test confirms the page agrees). Worth adding, but it's a test-authoring task independent of this spec.

**Why this is the right split (not "acknowledge and move on"):** top-level screens (`inbox`, `payables`, `periods`, `reports`, `settings`) were already in `nav-registry.js` before this spec; only the tab layer was missing. Extending the existing registry closes the gap with the grain of the codebase's own stated architecture, rather than justifying a second hardcoded table alongside it.

### §2 corrects a v1 citation error
v1 claimed all screen targets were "read directly off live tab ids in `settings.js` and `payables.js`" — untrue for `inbox`, `payables`, `periods`, `reports`, `settings` themselves, which come from `nav-registry.js`'s `route` field, not from any `showTab()` call. Only the *tab-level* entries (`coa`, `vat`, `partners`, etc.) are sourced from the pages' tab ids. §2's registry structure above makes this explicit: top-level keys come from `ROUTES[].route`, tab-level keys come from `ROUTES[].tabs[].id`.

---

## 3. Report targets

Ids come from `REPORT_REGISTRY` (`report-registry.js`): `pl`, `bs`, `cf`, `sce`, `tb`, `gl`, `journal`, `integrity`, `ap-aging`, `ap-control`, `ar`, `sie`, `voucher-register`. A new report type is `:show`-able automatically, no `fb-command.js` change required — matching the registry's own stated design goal.

### 3.1 Parser — period only accepted on report targets

**v1 bug:** `:show coa q2` matched `coa` in the screen table, returned the route, and silently dropped `q2`. `:show settings aug` had the same problem. This directly contradicted the command-bar spec's own §7.2 stance — silently dropping an argument is worse than the "guess and warn" behavior that section already rejects; at least a guess is visible.

**Fix:**

```js
function parseShow(tokens) {
  if (!tokens.length) return { error: 'usage: :show <screen|tab|report> [period]' };
  var target = tokens[0].toLowerCase();
  var screens = buildScreenTargets();

  if (screens[target]) {
    if (tokens.length > 1) {
      return { error: ':show ' + target + ' doesn\'t take a period — got "' + tokens[1] + '"' };
    }
    return { route: screens[target], commitMode: 'navigate' };
  }
  if (REPORT_IDS.indexOf(target) !== -1) {
    var url = '/reports?t=' + target;
    if (tokens[1]) url += '&period=' + encodeURIComponent(tokens[1]);
    return { route: url, commitMode: 'navigate' };
  }
  return { error: 'unknown target: ' + target + '. Valid: ' + validTargetsList() };
}

function validTargetsList() {
  return Object.keys(buildScreenTargets()).concat(REPORT_IDS).join(', ');
}
```

`validTargetsList()` (referenced but undefined in v1) is now specified: screen/tab keys (registry-derived, §2) concatenated with report ids, matching the same "helpful list of valid options" UX the removed `:new`/`parseNew` error path used.

`commitMode: 'navigate'` — matches what the removed `:report` entry already used, not the `commitMode: 'form'` + `warnings`-as-label pattern the removed `:new`/`NEW_ROUTES` table used.

### 3.2 Period shorthand resolution (`:show pl q2`)

Unchanged from v1: `fb-command.js` alias parsers stay synchronous — no network call. `q2`/`aug`/period-name tokens pass through raw as `&period=<token>` and get resolved in `reports-hub.js`, which already fetches `/api/:company/periods` on load and already has a `?t=` drill-through precedent:

1. Exact/fuzzy match against a fetched `period_name`.
2. `qN` → derive from the matched fiscal-year period using the same `addMonths`/`addDays` slicing `periods-page-service.js`'s `vatIntervalsFor()` already implements. Mirror it; don't reimplement it.
3. Bare month (`aug`) → calendar-month start/end — the fallback when no period list is loaded yet or nothing matches.
4. No match → keep the existing default-period behavior (most recent / last-used) and surface an inline note ("couldn't match period 'xyz' — showing latest") rather than guessing silently, per command-bar spec §7.2.

Consume-and-strip the `period` param once resolved, the same way `fb-list.js`'s `?new=1` handler does (`91b2d1a`).

---

## 4. `parseShow` return values — summary

| Case | Example | Result |
|---|---|---|
| Screen, no extra args | `:show settings` | `{ route: '/settings', commitMode: 'navigate' }` |
| Tab, no extra args | `:show coa` | `{ route: '/settings?tab=coa', commitMode: 'navigate' }` |
| Screen/tab **with** a trailing token | `:show coa q2` | `{ error: ':show coa doesn't take a period — got "q2"' }` |
| Report, no period | `:show pl` | `{ route: '/reports?t=pl', commitMode: 'navigate' }` |
| Report with period | `:show pl q2` | `{ route: '/reports?t=pl&period=q2', commitMode: 'navigate' }` |
| Unknown target | `:show frobnicate` | `{ error: 'unknown target: frobnicate. Valid: ...' }` |
| Bang | `:show! pl` | `{ type: 'unknown', error: ':show does not support !' }` (generic dispatch, §1) |

---

## 5. Known collision risk (unresolved, flagged)

The settings tab id `journals` (plural — journal *books*: MISC/BANK/ADJ/AP) and the report id `journal` (singular — Journal Line Listing) are one character apart. Exact-match dispatch means they don't collide as keys, but they're an easy typo. §2's registry entry above adds `books` as a secondary alias for the tab, which sidesteps it without committing to renaming `journals` itself — not a full resolution, still a judgment call for whoever implements this.

---

## 6. `:report` → `:show` cutover and discoverability

**v1 problem:** v1 cited the `:new` → `PALETTE` navigate-entries cutover (`91b2d1a`) as precedent for deleting `:report` outright with no shim. That precedent doesn't fully transfer: `:new`'s replacement destinations became visible *in the `:` dropdown itself* — a user who forgot the old command sees the new options by typing `:` and looking. `:show` replacing `:report` has no equivalent surface; a user back after time away types `:report pl`, gets a bare "unknown command," and nothing points them at `:show`. For a tool whose explicitly stated optimization target is "fast re-learning after time away" (command-bar spec header), that's a real sharp edge, not a nitpick.

**Rejected fix: silent auto-redirect.** Have `:report pl q2` transparently execute as `:show pl q2`. Rejected because it's the same category of problem §3.1 just fixed in the other direction — a command bar that can also fire `:post!`/`:pay!` shouldn't have a general mechanism for "silently reinterpret unrecognized input as a different command and run it." Grammar-compatible today doesn't guarantee grammar-compatible after the next rename; a visible hint is safer than an invisible substitution, and it's consistent with the existing "parse errors render inline in the bar itself, shell-style" philosophy (command-bar spec §4) — the fix stays in the same keystroke flow, it just doesn't run anything on the user's behalf.

**Adopted fix: a small, explicit, temporary rename map**, checked in the `unknown`-verb path of `parse()`'s main entry:

```js
var RENAMED = { 'report': 'show' }; // delete this line once the rename has settled

// inside parse(), where verb isn't found in ALIASES and isn't a raw catalog action:
if (RENAMED[verb]) {
  return { type: 'unknown', error: ':' + verb + ' is now :' + RENAMED[verb] + ' — try :' + RENAMED[verb] + ' ' + tk.tokens.join(' ') };
}
return { type: 'unknown', error: 'unknown command: ' + verb };
```

This is deliberately scaffolding, not a permanent alias — the comment says so, and removing it is a one-line diff once the muscle memory has moved (no different in spirit from how `ACTION_ALIASES`' `vendor.save` → `partner.save` shim was tracked for removal in `index.js`, per the command-bar spec §4 `:vendor`→`:partner` note). Unlike that shim, this one carries no runtime behavior to remove later — just an error-message improvement — so there's no correctness risk in leaving it slightly too long.

---

## 7. Migration checklist

- Add `tabs` arrays to the `settings` and `payables` entries in `nav-registry.js` (§2).
- Add `'show'` to `ALIASES` in `fb-command.js`, with `buildScreenTargets()` / `parseShow()` / `validTargetsList()` as specified (§2–§4).
- Delete the `'report'` entry from `ALIASES`.
- Add the `RENAMED` map and its check to `parse()`'s unknown-verb path (§6).
- Extend `reports-hub.js`'s period-loading `.then()` block to handle `?period=` (§3.2), mirroring the existing `?t=` drill-through and `fb-list.js`'s `?new=1` consume-and-strip pattern.
- Update `command-parser.test.js`:
  - remove `:report`-specific cases
  - add: `:show <screen>`, `:show <tab>` (incl. an alias like `:show ob`), `:show <report>`, `:show <report> <period>`
  - add: `:show coa q2` → error (§3.1 regression test — this is the bug this revision fixes, it should have a named test)
  - add: `:show frobnicate` → error listing valid targets
  - add: `:show! pl` → `:show does not support !`
  - add: `:report pl` → rename hint (§6)
  - add: `grammarFor('show')` returns the usage string
- **Follow-up, not in this pass:** the tab-existence CI linter described in §2 (grep `showTab`/`showPayTab` call sites against `nav-registry.js` `tabs`).

---

## 8. Explicitly out of scope for this pass

- Refactoring `settings.js`/`payables.js` to *render* their tab bars from `nav-registry.js` — this spec only requires the registry to be the place tab ids get *declared*, not the rendering source. Worth doing eventually for the same drift reasons as §2, but it's a larger, separate change.
- Resolving the `journals`/`journal` naming collision (§5) beyond the `books` alias.
- Any new backend action or catalog entry — `:show` remains a pure route command, no `action-catalog.js` change.
