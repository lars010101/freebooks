# freebooks — Global Period Selector & Chrome Rework Spec

**Date:** 2026-08-27 · **Status:** PROPOSED
**Scope:** Swap top-bar/bottom-bar contents (Company + new Period Selector move up, command/search bar moves down to sit with the mode indicator); build the global Period Selector control (Period-or-Custom, dimmed-but-clickable where irrelevant, end-date-only for as-of pages); wire it to consume the `dateRelevance` flag `ia-restructure-2-spec.md` §9 stubbed; retire the five local date pickers scattered across the app in favor of the one shared control.
**Sequencing:** This is the deferred follow-up named explicitly in `ia-restructure-2-spec.md` §0 item 1 — IA restructure shipped first (commit `9303d05`), chrome second, because this spec's per-page dimming logic depends on the final page list, which is now stable. The `dateRelevance` flag is **already committed** (`nav-registry.js` lines 73–97) — this spec is the consuming half, not a re-declaration.
**Companions:** `ia-restructure-2-spec.md` (§9 — the `dateRelevance` flag this spec consumes; §2.4 — the sessionStorage tab-memory pattern this spec's per-tab override hook parallels), `command-bar-ux-spec.md` (§3 — already specified the bottom-anchored status line and named `#fb-vim-mode` as a relocation, not new logic; this spec is the sibling relocation for the search/command input itself), `fb-list-default-period-spec.md` (already implemented in code despite its own DRAFT header — verified directly against `reports.js`/`payables-bills.js`/`exchange-rates.js`, not assumed; see §5), `report-registry.js` (`multiperiod`/`needsStart` fields — the per-report relevance source for Statements/Books, per `nav-registry.js`'s own comment at line 79–81).
**Consumers:** `api/src/pages/common.js` (`navBar()`, `layoutEnd()`), `api/public/common.css` (top-bar/status-line rules, `.fb-palette`/`.fb-grammar-hint` anchor direction, `.tb-company-dropdown` positioning), `api/public/common.js` (company-switcher wiring — unchanged logic, relocated trigger), `api/public/fb-core.js` (new `FB.period` module, alongside the existing `FB.switcher`/`FB.mode`/`FB.palette`), `api/src/pages/reports-hub.js` (period-resolution engine hoisted out, page becomes a consumer), `api/src/pages/payables.js` / `payables-bills.js` / `ap-aging.js` (date inputs retired), `api/src/pages/exchange-rates.js` (date inputs retired, currency picker kept), `api/src/pages/bank-reconcile.js` (date inputs retired).

---

## 0. Design decisions already settled in review (recap, for a self-contained spec)

All dated 2026-08-27, all from the same design-review thread this spec formalizes:

1. **Bar swap.** Top bar: Company (click → switcher) · Period Selector · Notifications Bell · Help. Bottom bar: search/command input · NORMAL/INSERT mode indicator. Motivated by real vim precedent (`:` command line lives at the bottom next to the mode indicator in actual vim) — this app already leans on vim semantics (`g`-motions, NORMAL/INSERT), so the swap is *more* consistent with that model, not a departure from it.
2. **Permanent, not per-page.** One global Period Selector instance in the top bar, always rendered, never built per-page. Five pre-existing local pickers (Statements/Books, Bills, Exchange Rates, AP Aging, Bank Reconcile) are retired in its favor (§5).
3. **Dim, don't hide.** On pages where the date dimension doesn't apply, the control renders visually dimmed but stays clickable — false affordance (looks live, does nothing) is worse than visible inactivity, and hiding would reflow the top bar between pages (chrome shouldn't jump). This is the same "default, not hard binding" model applied throughout: the control is never truly disabled anywhere.
4. **End-date-only for as-of pages (the Odoo pattern).** A snapshot report ("as of") reads only the selector's end boundary — it does not need or get its own separate control. This eliminated AP Aging/AP Control as a structural exception; they're a mode of the same control, not a different control.
5. **Period-or-Custom, everywhere, no exceptions.** Every page that needs a date range gets both a defined-Period picker and a Custom start/end fallback from the *same* control. Bank Reconcile — whose statement cycle rarely aligns with fiscal period boundaries — doesn't need bespoke UI for this reason; it's simply the page most likely to land in Custom mode most often, which is an expectation to document (§5), not a design exception.
6. **Per-page flag, chrome-consumed.** `nav-registry.js`'s `dateRelevance` (`'range' | 'asOf' | 'none'`) is a declarative per-page config value, read by a shared framework — the same shape as the report registry, jurisdiction packs, and `FB.list` page configs already use elsewhere in this app. This spec is what makes that flag do something.

---

## 1. What's actually in the chrome today (verified against source, not assumed)

`api/src/pages/common.js`:

- **Top bar** (`navBar()`, ~L134–166): `.tb-left` holds `.tb-global-controls` — the search/command input (`#tb-global-search`) plus a status message span (`#tb-status-msg`). `.tb-right` holds per-page dynamic action slots (`ctx.actions`, currently inert everywhere — `topBarContext()` returns `{nav:'', actions:''}` for every key), a static "+ Journal Entry" button, the notifications bell (`#tb-notif-btn`, badge + dropdown already built per `fx-automation-spec.md` §7), and the `?` help button.
- **Bottom status line** (`layoutEnd()`, ~L169–183): `.fb-sl-company` (clickable, opens `#tb-company-dropdown` via `fbToggleCompany()`), a separator, `#fb-sl-period` (a bare `<span>`, **rendered but never populated by any JS** — dead chrome, confirmed by grep; this is the slot this spec's Period Selector replaces, not a decoration to preserve), another separator, `.fb-sl-inbox` (pending-count text, populated by A5 §10.4's inbox-badge logic in `fb-core.js`), a flex spacer, and `#fb-vim-mode` (NORMAL/INSERT, driven by `FB.mode.onChange`).

So the starting state is closer to the target than a naive reading suggests: the bell and help icon are *already* in the right place, the company switcher and mode indicator already exist, they're just on the wrong bars. `#fb-sl-period` already reserved the slot for a period display and never got wired up. This is a rearrangement plus one new control, not new chrome built from nothing.

---

## 2. Bar swap — exact DOM move

### 2.1 Top bar becomes

```
.tb-left:  [Company name/switcher trigger]  [Period Selector]
.tb-right: (unchanged) ctx.actions · + Journal Entry · 🔔 · ?
```

`.fb-sl-company`'s markup (and its `onclick="fbToggleCompany(event)"`) moves from `layoutEnd()` into `navBar()`'s `.tb-left`, ahead of the new Period Selector markup (§3). No JS in `fbToggleCompany()`/`fb-core.js`'s `g c` handler needs to change — both already look up `#tb-company-dropdown` and `.fb-sl-company` by id/class, not by DOM position.

**Follow-on fix, opportunistic, same file already being touched:** `.tb-company-dropdown` (`common.css` ~L233–244) is `position:absolute; top:calc(100% + 4px)` with **no positioned ancestor** anywhere in its containing-block chain (`#app-shell`, `#main-area` are unpositioned) — its containing block is the initial containing block (viewport), not the company trigger it visually sits next to. This is a pre-existing latent issue, not something this spec's move introduces, but relocating the trigger touches this rule regardless, so fix it in the same pass: switch to `position:fixed; top:52px; left:24px` (matching `top-bar`'s own height and the working precedent `.tb-notif-dropdown` already uses at ~L385–397, rather than reinventing a second positioning strategy).

### 2.2 Bottom bar becomes

```
[search/command input (#tb-global-search, #tb-status-msg)] · [fb-sl-inbox] · spacer · [#fb-vim-mode]
```

`.tb-global-controls` (the whole search/command block, ids unchanged: `#tb-global-search`, `#tb-status-msg`) moves from `navBar()`'s `.tb-left` into `layoutEnd()`'s `#fb-status-line`, ahead of the existing `fb-sl-inbox`/spacer/`#fb-vim-mode` group. `.fb-sl-sep` separators are dropped between the moved-out company/period spans (gone from this bar) and kept between inbox/mode as needed for readability.

**No JS change required for the moved input itself.** Every reference to it in `fb-core.js`/`fb-list.js`/`common.js` is by `id="tb-global-search"` or `.closest('.tb-search-wrap')` — none of it depends on being inside `#top-bar`. Confirmed by grep: `fb-core.js` L559, L1410, L1650 all do `_input.closest('.tb-search-wrap')`; moving the wrapper node preserves this untouched.

**`fb-sl-inbox` placement — explicit default call, flagged for sign-off.** The design discussion's stated bottom-bar contents were "search/command bar … the NORMAL/INSERT indicator" — it didn't mention the pending-inbox count either way. This spec's call: leave `fb-sl-inbox` where it is (bottom bar), since it wasn't named for removal and least-diff is the safer default for an unaddressed item. Flagged in §7 for confirmation rather than assumed silently.

### 2.3 CSS: dropdown/hint anchor direction must flip

Two rules currently anchor **below** the input, assuming top-bar placement (`common.css`):

- `.fb-palette` (~L544–560, the `:`/`/` command dropdown): `top: calc(100% + 4px)`
- `.fb-grammar-hint` (~L650–654, the argument-grammar hint line): `top: calc(100% + 4px)`

Once `.tb-search-wrap` lives in the bottom-anchored status line, opening downward runs off the bottom of the viewport. Both rules flip to `bottom: calc(100% + 4px); top: auto` — opens upward, into the page content above, which has the room (the whole viewport minus a 28px bar, versus what used to be minus a 52px bar and whatever page content was below it). `command-bar-ux-spec.md` §3 already anticipated this exact wrinkle in passing ("the command palette's dropdown/ghost-text currently anchors below the top-bar input — moving to the bottom bar means that dropdown needs to open upward instead") — this section is where it actually gets specified.

**`.fb-ghost-hint` (~L640–648) needs no change.** Its position is set imperatively in JS (`fb-core.js` ~L559–567) as an exact overlay on the input's own text (`top`/`left` computed from the input's `getBoundingClientRect()` minus the wrap's), not a below-anchored dropdown — it moves correctly with its wrapper automatically.

**`.fb-palette`'s `position:absolute` depends on `.tb-search-wrap` being `position:relative` — confirmed this dependency survives the move unchanged.** `.fb-palette` has no `position:relative` of its own on a containing wrapper in the CSS; it relies on `.tb-search-wrap` supplying that containing block. That's set imperatively, not in CSS: `fb-core.js` L1411 and L1651 both run `wrap.style.position = wrap.style.position || 'relative'` on `_input.closest('.tb-search-wrap')` at dropdown-open time, not on page load. Because this runs via `closest()` against whichever element currently carries the `.tb-search-wrap` class — found fresh every time a dropdown opens — it resolves correctly regardless of where that element sits in the DOM. No change needed here; stated explicitly because it's exactly the kind of runtime-set styling that's easy to assume is static CSS and miss when reasoning about a DOM move.

---

## 3. The Global Period Selector

### 3.1 Placement and trigger

Renders in the top bar, immediately right of the company name (§2.1). Collapsed state shows the current resolved label (a period name, or `start – end` in Custom mode). Click opens a popover — model its positioning on the same `position:fixed; top:52px` pattern used for `.tb-notif-dropdown` and the relocated company dropdown (§2.1), not a third positioning strategy.

### 3.2 Popover contents — Period or Custom, per §0 item 5

```
[ Period ▾ ]  (dropdown of defined fiscal periods, "Custom" as the last option)
  — when Period is selected: nothing else shown, popover can close on select
  — when "Custom" is selected:
      [ Start: <date> ]  [ End: <date> ]     (dateRelevance = 'range')
      [ End: <date> ]                         (dateRelevance = 'asOf' — Start never rendered)
```

This is not new interaction design — it's `reports-hub.js`'s existing period-dropdown-plus-free-dates shape (§4 confirms it's the most complete implementation of this pattern in the app today), generalized into the one shared control and promoted out of Reports.

**"Close on select" means immediately, no confirm button.** Picking a defined period closes the popover and fires the change (§3.7) in the same action — there is no separate apply/confirm step. This matches the existing behavior exactly: `reports-hub.js`'s `#rpt-period` select already fires `fbOnPeriodChange()` on plain `onchange` (L63, L373–381), which sets the date fields and calls `fbLoadReport()` with no intervening confirmation. The new control keeps that zero-friction behavior rather than introducing a confirm step the current UI has never had. Custom mode's Start/End inputs commit the same way the existing `#rpt-start`/`#rpt-end` inputs do — on `change` (blur or Enter), not on every keystroke — and the popover stays open while editing Custom dates (only the Period-dropdown pick auto-closes; typing dates has no natural "done" moment to detect).

### 3.3 State shape and persistence

```
{ mode: 'period' | 'custom', periodId, start, end }
```

Persisted under a **new, shared** localStorage key set — `fb-period-mode`, `fb-period-id`, `fb-period-start`, `fb-period-end` — replacing the various per-page equivalents this spec retires (`fb-rpt-period`/`fb-rpt-start`/`fb-rpt-end` in `reports-hub.js`; no prior persistence existed for Bills, Exchange Rates, AP Aging, or Bank Reconcile's date inputs — those were URL-param-only or session-transient). One shared key set, not five.

**This does not mean "always read localStorage on page load."** `reports-hub.js` carries an explicit, hard-won rule directly in its comments (L147–148): *"localStorage is NOT used for auto-selection — it was causing stale 2025 periods. localStorage is only written when the user manually picks a period."* That lesson transfers unchanged to the shared control — see §3.4 for the exact priority order, which localStorage is deliberately absent from. localStorage here exists for one purpose only: so a period picked by hand on one page is still showing when the user lands on the next date-relevant page in the *same* session, without that pick silently overriding what a fresh session should default to. It is read by §3.4's step 3, not step 1.

### 3.4 Sourcing and initial-value priority

Carries forward `reports-hub.js`'s existing v7 priority order (L143–148) unchanged — this control does not introduce a new resolution policy, it generalizes the one already proven correct:

1. **Explicit navigation intent** — a `?period=` or `?start=`/`?end=` URL param (drill-through from a report, a `:report` command-bar target, a return-context link). Always wins; this is a deliberate override, not a default.
2. **Latest posted-transaction period** — `GET /api/:company/reports/default-period`, resolving to the period containing the most recent journal entry, never future-dated (`reports.js` ~L217–243). **Verified live in code**, not assumed from its spec doc: the endpoint already returns `{ period_id, start_date, end_date }`, matching exactly what `fb-list-default-period-spec.md` proposed adding — that spec's own header still says "DRAFT," but the code is ahead of the doc, same drift pattern `ia-restructure-2-spec.md` had to reconcile for other specs.
3. **Fallback: the latest defined period by `start_date`** (`periods[0]` after the existing descending sort) if step 2 returns nothing (no posted activity yet).

**localStorage's actual role, stated precisely:** never consulted for the *initial* auto-selection above — only written when the user manually picks a period or commits Custom dates, and only read back to restore that manual pick across page navigations within the same browser session (the same DOM-move-safe mechanism `reports-hub.js` already uses, just promoted to the shared key set from §3.3). A stale value from a prior session cannot resurface as a wrong default the way the pre-fix bug did, because step 1–3 above always run first on a fresh load; localStorage only matters for in-session continuity between date-relevant pages, not as a fourth fallback tier.

**Defined periods list, unrelated to the priority order above:** `GET /api/:company/periods` — the same endpoint and response shape (`period_name`, `start_date`, `end_date`) `reports-hub.js` already fetches and sorts descending by `start_date`. Reuse that fetch/sort/render logic verbatim in the new shared control; do not reimplement it a second time.

### 3.5 Resolving a period token — hoisted, not reimplemented

`reports-hub.js` (~L126–296) already contains the app's most complete "resolve a period reference to concrete dates" engine: `?period=` URL-param matching (exact name, substring, `q1`–`q4`, `h1`/`h2`, `ytd`), `?start=`/`?end=` drill-through restoration with period-matching fallback to `'custom'`, and the default-period fetch fallback chain (§3.4). This logic **moves** into the new shared `FB.period` module (§3.7) — `reports-hub.js` keeps none of its own copy, it becomes a caller. This is a genuine code relocation, not a re-spec of new logic; flag it as such in implementation estimates (nontrivial function, ~170 lines, currently entangled with `reports-hub.js`-specific globals like `RPT_META`/`currentType` that need to be parameterized out during the move).

**Call-shape sketch — the contract an implementer needs, not left to reverse-engineering.** The existing code is entangled with DOM writes: `setAndLoad` (L152–163) directly sets `periodEl.selectedIndex`, `#rpt-start`/`#rpt-end` `.value`, writes localStorage, and calls `fbLoadReport()`, all in one function — resolution and rendering are one step today. The hoisted version must split them:

```js
// Pure resolution — no DOM reads, no DOM writes, no localStorage.
// Input: the URL's own query params, plus the already-fetched periods list.
// Output: a plain data object; the caller decides what to do with it.
FB.period._resolve(urlParams, periods) → { mode: 'period'|'custom', periodId, start, end } | null
```

`_resolve` is the internal engine called once at control init; it replaces the `?period=`-matching, `?start=`/`?end=`-restoring, and default-period-fetch branches (L149–296) with one pure function returning a state object per §3.3's shape — never `null` in practice given the step-3 fallback in §3.4, but typed as nullable since the function has no fallback of its own to fall back to if `periods` is empty. The control's init code takes that return value and calls the same `set()` (§3.7) every other write path uses to apply it to state, fire the change event, and persist — there is exactly one code path from "resolved state" to "applied state," not a special init-time path plus a separate runtime-pick path. `reports-hub.js` post-migration calls `FB.period.get()` to read the current resolved value and renders it into its own report request — it never touches `#rpt-start`/`#rpt-period` again because those elements no longer exist (§5).

### 3.6 Dimming

- On page load, the control reads the current route's `dateRelevance` from `window.FB_ROUTES` (already injected by `navBar()`) and applies a `.tb-period-dimmed` class when `'none'`.
- Per §0 item 3: dimmed means reduced opacity, **not** `pointer-events:none` and **not** `disabled` — the control stays fully operable while dimmed, so the user can stage the next report's period while sitting on an unrelated page.
- Pages with internal tabs/reports whose relevance varies **within the page** update this live via `FB.period.setRelevance(...)` (§4.2) — the initial `dateRelevance` from the registry is a page-load default, not necessarily the value for the whole session on that page.

### 3.7 Public API — `FB.period`

New module in the existing `window.FB` table (`fb-core.js` ~L2575, alongside `mode`, `keys`, `dropdown`, `palette`, `switcher`, etc. — same convention, not a new pattern):

```js
FB.period = {
  get()                    // → { mode, periodId, start, end } — current resolved state
  set(state)               // → programmatic set (drill-through return-context, ?period=/?start=/?end= URL restoration)
  setRelevance(level)      // → 'range'|'asOf'|'none' — per-tab/per-report override, §4.2
  onChange(cb)             // → subscribe; also available as the 'fb:period-change' DOM CustomEvent on `document`
}
```

`onChange`/`fb:period-change` fires whenever the resolved `{start,end}` actually changes (period selected, Custom dates committed on blur/Enter) — **not** on every keystroke. Any page's `FB.list` instance wires its `list.body()` to read `FB.period.get()` and calls `.load()` from the change handler — this is exactly the existing "small shared control … wires into `list.body()` and calls `.load()` on change" pattern `fb-list-default-period-spec.md` §3 already established as zero-framework-change, page-level work; this spec's control is a drop-in replacement source for that same wiring, not a new integration shape.

---

## 4. `dateRelevance` consumption contract

### 4.1 Page-level default (already declared, per `ia-restructure-2-spec.md` §9)

| Route | `dateRelevance` | Selector behavior |
|---|---|---|
| `inbox`, `fiscal`, `settings`, `accounting`, `journal-voucher`, `new-company` | `none` | dimmed, full page session |
| `payables` | `range` (page-level default; overridden per-tab, §4.2) | active on load (Bills is the default tab) |
| `exchange-rates` | `range` | active, full page session — date inputs retired (§5), currency picker unaffected |
| `statements`, `books` | `none` (intentional placeholder, per the registry's own comment) | overridden per-report immediately on mount, §4.2 |

### 4.2 Per-tab / per-report override — a gap this spec's research surfaced, not previously flagged

`nav-registry.js`'s `dateRelevance` is one flat value per **route**. Two of the routes it covers are not internally uniform:

- **Payables** (`payables.js`, four tabs): per `ia-restructure-2-spec.md` §9's own table, Bills=`range`, Vendors=`none`, Aging=`asOf`, Control=`asOf`. Checked `payables.js` directly — **no per-tab flag exists in code today**, only the flat `dateRelevance:'range'` on the route entry, which is wrong for three of its four tabs. `payables.js` must call `FB.period.setRelevance(...)` on every tab switch, in the same place it will already be writing `sessionStorage.fb.tab.payables` per `ia-restructure-2-spec.md` §2.4 — one tab-switch handler, two side effects, not two separate hooks.
- **Statements/Books** (`reports-hub.js`): relevance is per-report, not per-page — `REPORT_REGISTRY[currentType].needsStart` (`true` → `range`, `false` → `asOf`) is the source of truth, exactly as `nav-registry.js`'s own comment (L79–81) already anticipates. `reports-hub.js` calls `FB.period.setRelevance(...)` every time `currentType` changes (report-type dropdown, drill-through navigation).

Every other route's flat registry value is correct as-is and needs no override call.

**Dimmed does not mean silent — `fb:period-change` still fires on a `'none'` page, nothing is listening, that's expected.** Per §0 item 3 the control stays clickable while dimmed, so a user can change the period while sitting on Settings or Fiscal. §3.7's `onChange`/`fb:period-change` fires exactly the same way it would on a `range` page — there is no dimmed-mode suppression of the event. The difference is entirely on the *consumer* side: a `'none'` page simply has no `FB.list` instance wired to that event, so nothing visibly reacts, and the new value sits in state (and localStorage, once committed) until the user navigates to a page that does listen. This is the same "default, not hard binding" model already named in §0 item 5 and §7 item 3 — restated here because the combination of "visibly dimmed" + "silently still works" is the one place in this spec where a reader could plausibly expect the event to be suppressed and it deliberately isn't.

### 4.3 AP Aging / AP Control specifically

Both read `FB.period.get().end` directly as the as-of date, in place of their current local `#asof-date` input (`ap-aging.js` L106) — `bill.aging`'s `asOfDate` param is unaffected server-side, only its client-side source changes. Neither page ever reads `.start`.

---

## 5. Per-page migration — retiring the five local pickers

| Page / tab | Local control today (verified in source) | Disposition |
|---|---|---|
| Statements / Books (`reports-hub.js`) | `#rpt-period` select + `#rpt-start`/`#rpt-end` date inputs; `fb-rpt-period`/`fb-rpt-start`/`fb-rpt-end`/`fb-rpt-step` in localStorage | **Retired.** Toolbar markup removed; period-resolution engine hoisted into `FB.period` (§3.5), page becomes a pure consumer wired per §4.2. MoM/YoY step buttons (`fb-rpt-step`) are unaffected — orthogonal to date range. |
| Payables → Bills (`payables.js` L362–364) | `#bill-date-from`/`#bill-date-to`, URL-param seeded only (`?dateFrom=`/`?dateTo=`), no localStorage | **Retired.** Reads `FB.period.get()` in `range` mode; the existing `?dateFrom=`/`?dateTo=` return-context seam (`payables-bills.js` L308–318, built for future drill-through) becomes a call to `FB.period.set(...)` instead of setting local inputs directly. |
| Payables → Vendors | none | Unaffected; page tab sets relevance `none` on switch (§4.2). |
| Payables → Aging / Control (`ap-aging.js` L106) | `#asof-date` single date input | **Retired.** Reads `FB.period.get().end` (§4.3). |
| Exchange Rates (`exchange-rates.js` L49–55) | `#fx-foreign-currency` select + `#fx-date-from`/`#fx-date-to` | **Date inputs retired**, wired to `FB.period` (`range` mode). **Currency picker (`#fx-foreign-currency`) stays local** — it's an orthogonal dimension (which currency), not a date control, and `fx-tracked-currency-scoping-spec.md`'s hard single-currency requirement is unaffected by this spec. |
| Bank Reconcile (`bank-reconcile.js` L45–46, L79–84) | `#rec-from`/`#rec-to`, no persistence | **Retired.** Reads `FB.period.get()`. Per §0 item 5: no special-case UI — this is simply the page where the user is expected to switch the selector to Custom most often, since bank statement cycles rarely align with fiscal periods. Documented here as an expectation, not built as an exception. |

---

## 6. Implementation note — sequencing within this spec itself

Do the bar swap (§2) and the `FB.period` module (§3) as one change, not two: the swap alone (moving markup with no new control) is low-risk but pointless on its own — `#fb-sl-period`'s replacement is the entire reason for the move. Land the per-page retirements (§5) in the same change too, not as follow-ups — a period selector that half the app still ignores in favor of its old local picker is worse than the status quo (two sources of truth for "what period am I looking at," silently drifting).

---

## 7. Open questions / parking lot

1. ~~**`fb-sl-inbox` placement** (§2.2)~~ **Resolved (2026-08-27): confirmed.** Stays in the bottom bar — `[search/command input] · [inbox count] · spacer · [mode]` is the agreed layout, least-diff and reasonable on its own terms.
2. **`.tb-company-dropdown` positioning fix** (§2.1) — bundled into this spec opportunistically since the trigger relocation touches the same rule anyway. Flagging that it's a pre-existing latent issue this spec happens to fix, not a bug newly introduced by the swap.
3. **No in-UI "this is shared" affordance is designed** for the moment a user edits Custom dates on a page like Bank Reconcile and implicitly changes what every other page will default to next. Confirmed acceptable under the agreed "default, not hard binding" model (§0 item 5), but a first-run tooltip or similar polish is not designed here — flagged as a possible future addition, not blocking this spec.
4. **`reports-hub.js`'s MoM/YoY step-comparison feature** (`fb-rpt-step`) sits right next to the period controls being retired but is explicitly out of scope — confirm during implementation that hoisting the period engine out doesn't disturb the step-button enable/disable logic (`RPT_META[currentType].multiperiod`), which reads `currentType` independently of the date fields.

---

## 8. Changelog

| Date | Change |
|------|--------|
| 2026-08-27 | Spec drafted per design-review discussion (five rounds, same thread as `ia-restructure-2-spec.md`): top/bottom bar swap, global Period Selector (Period-or-Custom, dimmed-not-hidden, end-date-only for as-of pages), `dateRelevance` consumption contract including a per-tab/per-report override gap found during this spec's own research (Payables tabs, Statements/Books reports), five local date pickers scheduled for retirement in favor of the one shared control. Status: PROPOSED, pending ratification. |
| 2026-08-27 | Review round applied: (1) §3.5 added a call-shape sketch for the hoisted period-resolution engine (`_resolve(urlParams, periods) → {mode,periodId,start,end}`, pure — no DOM reads/writes) since "hoist, don't reimplement" left the DOM/data separation implicit; (2) §3.2 made "close on select" explicit — fires immediately on Period pick, no confirm button, matching `#rpt-period`'s existing plain-`onchange` behavior; Custom-mode inputs commit on change same as today, popover doesn't auto-close for those; (3) §3.3–§3.4 corrected — the initial-load priority now explicitly carries forward `reports-hub.js`'s hard-won "localStorage is NOT used for auto-selection" rule (its own L147–148 comment), restated as a 3-step priority (URL params → default-period fetch → `periods[0]`) with localStorage demoted to in-session continuity only, not a fourth fallback tier; (4) §2.3 added an explicit note that `.fb-palette`'s `position:relative` dependency on `.tb-search-wrap` is set imperatively at dropdown-open time via `closest()` (`fb-core.js` L1411/L1651), so it survives the DOM move with no code change; (5) §4.2 added a note that `fb:period-change` still fires on dimmed (`dateRelevance:'none'`) pages — dimming is a consumer-side no-listener state, not event suppression; (6) §7 item 1 (`fb-sl-inbox` placement) confirmed, not just defaulted. |
