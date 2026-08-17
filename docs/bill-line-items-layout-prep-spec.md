# Bill Line-Items Layout: Config Extraction + Responsive Row Prep — Spec

**Status:** Draft v1
**Scope:** `api/src/pages/bill-edit.js` (the line-items table + its container), plus one shared, opt-in rule added to `api/public/common.css`.
**Depends on:** nothing outstanding. Touches a different DOM region than `bill-edit-header-cleanup-spec.md` (line-items table vs. header grid) — the two can land in either order, or together, without conflict.
**Precedes:** the future specs for #3 (quantity × unit price) and #4 (withholding tax) — this spec's whole purpose is to make those additive, not another round of hand-rebalanced percentages.

---

## 0. Context and scope

Two things prompted this, both from the same conversation:

1. **#3 and #4 are coming.** The line table's column widths are currently hand-typed percentages, already forked once by `vatOn`. Two more columns (qty, rate, and later a WHT code) will make that worse, not better, if nothing changes first.
2. **Two new constraints surfaced that directly affect the row-layout decision:** the page wastes horizontal space on wide desktop screens (`.page { max-width: 1100px }` is a shared, app-wide cap), and the form should eventually work on mobile, where no version of "one row per line item" survives regardless of how clever the column config is.

Both are addressed here because the second one determines the answer to the first: how much horizontal budget the line table actually has determines whether 6–9 fields fit in one row or need to split into two, at which viewport widths, and what happens when there isn't room for two either.

### 0.1 This is compatible with the ratified keyboard doctrine, not a workaround of it

`docs/keyboard-ux-spec.md` §0 freezes the verb surface and treats the web UI as "a viewer plus a small human correction surface" — worth checking this doesn't quietly reopen that. It doesn't: everything below is a **rendering** change (what HTML the line rows are built from), not an **interaction** change (no new verbs, no changed key bindings, no changed zone/cell contract). Two concrete confirmations from the actual framework CSS/JS, not an assumption:

- `FB.form`'s cell cursor styling is applied to the input/select/button element itself, never to its parent row — `.fb-form-cursor`, `.fb-form-cursor-btn` (`common.css` lines 855–871) don't reference `<td>` or `<tr>` anywhere.
- Row-focus highlighting **already has an explicit non-table case**: `tr.fb-form-row-focus > td, div.fb-form-row-focus { background: var(--bg); }` (`common.css` line 854). A `<div>`-based row was already anticipated, not something this spec is bolting on.

So §4's table→CSS-Grid migration is a drop-in swap from the framework's point of view: `FB.form`'s zone `rows()` function just needs to return the new row elements instead of `<tr>`s (§4.3), and its default `cells()` selector (`input,select,textarea` — `fb-form.js` line 56) already works on any container element.

---

## 1. Desktop: stop wasting the width you have

### 1.1 The cap is app-wide, and it's right for most of the app

```css
/* common.css */
.page {
  padding: 36px 48px;
  max-width: 1100px;
  color: var(--text);
}
```

This is a shared rule with zero `@media` overrides anywhere for it — `common.css` itself has **zero `@media` rules at all**. Four `@media` blocks exist in the whole codebase, but three of them (`reports-hub.js`, `report-composite.js`, `reports/render.js`) are `@media print` rules for printable report output, not screen breakpoints. Exactly **one** real responsive (`max-width`) breakpoint exists anywhere in the app today: `company.js`'s dashboard card grid. A 1100px cap is a reasonable, deliberate choice for prose-shaped pages — Settings, Reports, the dashboard — where a shorter line length aids readability. It's the wrong cap for a dense data-entry grid, where more width means fewer squeezed columns, not harder reading.

### 1.2 Fix: a page-scoped modifier, not a global change

Don't touch `.page` itself — other pages are tuned for it. Add an opt-in modifier:

```css
/* common.css, near the existing .page rule */
.page.page-wide { max-width: min(94vw, 1600px); }
```

And in `bill-edit.js`, change the page wrapper from `<div class="page">` to `<div class="page page-wide">`. `min(94vw, 1600px)` reclaims most of the unused space on wide monitors while still capping at a sane ceiling on ultrawide displays — a data grid stretched across a 32" monitor at zero cap gets uncomfortable too, just at a much higher threshold than prose does.

This is scoped to this one page. Applying `page-wide` to other data-grid-heavy screens (journal voucher, bank matching) is a reasonable, cheap follow-up, but isn't part of this spec — no reason to touch pages nobody's complained about.

---

## 2. Column config: one array, not hand-typed percentages in N places

### 2.1 The config

```js
// Line-item column config — single source of truth for the header row and
// every line row. Extend this array (not hand-typed widths in separate
// places) when #3 (qty × unit price) and #4 (withholding tax) land — see
// §3.2 for the reserved slots those specs will fill in.
//
// INVARIANT: tier-1 entries must precede tier-2 entries in this array.
// §3.4's Tier-B rendering groups cells by `tier` and relies on each group's
// internal order matching this array's order — see §2.3.
const LINE_COLUMNS = [
  { id: 'desc', label: 'Description',        cls: 'bl-desc',   tier: 1 },
  // Reserved for the #3 spec (qty × unit price) — do not build ahead of it:
  // { id: 'qty',  label: 'Qty',                cls: 'bl-qty',    tier: 1 },
  // { id: 'rate', label: 'Rate',               cls: 'bl-rate',   tier: 1 },
  { id: 'amt',  label: 'Amount',              cls: 'bl-amt',    tier: 1 },
  { id: 'vat',  label: 'VAT code',            cls: 'bl-vat',    tier: 2, conditionalOn: () => VAT_ON },
  // Reserved for the #4 spec (withholding tax) — do not build ahead of it:
  // { id: 'wht',  label: 'WHT code',           cls: 'bl-wht',    tier: 2, conditionalOn: () => WHT_ON },
  { id: 'cc',   label: 'Cost center',         cls: 'bl-cc',     tier: 2 },
  { id: 'acct', label: 'DR: Expense account', cls: 'bl-acct',   tier: 2 },
  { id: 'del',  label: '',                    cls: 'be-line-x', tier: 2 },
];
function activeColumns() { return LINE_COLUMNS.filter(c => !c.conditionalOn || c.conditionalOn()); }

// Tier A (wide, single row) column-track widths, keyed by column id — see
// §3.3. Kept separate from LINE_COLUMNS itself so the reserved/commented
// entries above can stay terse; a width only needs to exist once its column
// is actually wired up in renderCell (§2.3).
const WIDE_TRACK_WIDTH = {
  desc: 'minmax(240px,3fr)', qty: 'minmax(70px,0.6fr)', rate: 'minmax(90px,0.7fr)',
  amt:  'minmax(90px,0.8fr)', vat: 'minmax(90px,0.8fr)', wht:  'minmax(90px,0.8fr)',
  cc:   'minmax(120px,1fr)',  acct: 'minmax(180px,1.6fr)', del: '32px',
};
function computeWideColumns() { return activeColumns().map(c => WIDE_TRACK_WIDTH[c.id] || '1fr').join(' '); }
```

`conditionalOn` is a function, not a string flag re-evaluated with `eval`-style lookups — cheap, explicit, and matches how `VAT_ON`/`FX_ON` are already plain page-scoped `const`s elsewhere in this file.

**On the CSS-Grid empty-track problem (flagged in review, and worth explaining since it reshaped this section):** the original draft of this spec used named `grid-template-areas` (e.g. `"desc amt vat cc acct del"`) built once as a static string, with the VAT column dropped from the *generated HTML* when `vatOn` was false. That's broken — `grid-template-areas` declares its column tracks at parse time regardless of whether any element actually claims a given area name, so an unused `"vat"` area still reserves its track and renders as a visible empty gap. The fix below avoids the problem structurally rather than patching around it: **no named areas anywhere.** Tier A relies on plain positional `grid-template-columns`, computed by `computeWideColumns()` above so it always has *exactly* as many tracks as `activeColumns()` has entries — never more, never fewer, so there's no unclaimed track to leave a gap. Tier B (§3.4) doesn't use a shared grid at all, for a separate reason explained there.

### 2.2 Header row — generated, not hand-written

**Before** (lines 111–123):

```html
<table class="be-lines">
  <thead>
    <tr>
    <th style="width:36%">Description</th>
    <th style="width:13%">Amount</th>
    ${vatOn ? '<th style="width:13%">VAT code</th>' : ''}
    <th style="width:15%">Cost center</th>
    <th style="width:21%">DR: Expense account</th>
    <th style="width:2%"></th>
    </tr>
  </thead>
  <tbody id="be-lines-body"></tbody>
</table>
```

**After** (markup — the header row's *content* is generated client-side from `LINE_COLUMNS`, so the server-rendered shell just needs empty containers, wrapped in one element so `--bl-cols` can be set once and inherited by both the header and every row):

```html
<div class="be-lines-wrap" id="be-lines-wrap">
  <div class="bl-header" id="be-lines-header"></div>
  <div id="be-lines-body"></div>
</div>
```

```js
function renderLinesHeader() {
  document.getElementById('be-lines-header').innerHTML =
    activeColumns().map(c => '<div class="bl-cell">' + FB.util.esc(c.label) + '</div>').join('');
}
function applyGridColumns() {
  document.getElementById('be-lines-wrap').style.setProperty('--bl-cols', computeWideColumns());
}
```

Call both once, alongside the existing init flow (right where `updateTotals()`/`takeSnapshot()` are called after load — `bill-edit.js` lines ~202–205). `VAT_ON` is a page-load constant (server-rendered into the script, never changes mid-session), so this genuinely only needs to run once — no reactivity machinery, no resize listener, no recomputation on breakpoint changes. The header needs no `tier` grouping (unlike §2.3's rows) because it's hidden outright in Tier B (§3.4) — it only ever renders in the one layout where plain positional order applies.

### 2.3 Row builder — `addLine()` reads the same config, grouped by tier

**Before** (lines 326–344): a single hard-coded `tr.innerHTML` string with a `VAT_ON`-conditional cell inline.

**After:**

```js
function renderCell(col, data) {
  var inner;
  switch (col.id) {
    case 'desc': inner = '<input class="bl-desc" value="' + FB.util.escAttr(data.description || '') + '" placeholder="line description">'; break;
    case 'amt':  inner = '<input class="bl-amt" type="number" step="0.01" min="0" placeholder="Amount" value="' + (data.amount !== '' && data.amount != null ? data.amount : '') + '">'; break;
    case 'vat':  inner = '<input class="bl-vat" value="' + FB.util.escAttr(data.vat_code || '') + '" autocomplete="off" placeholder="—">'; break;
    case 'cc':   inner = '<input class="bl-cc" value="' + FB.util.escAttr(data.cost_center || '') + '" autocomplete="off" placeholder="Cost center">'; break;
    case 'acct': inner = '<input class="bl-acct" value="' + FB.util.escAttr(data.expense_account || '') + '" autocomplete="off" placeholder="Expense acct">'; break;
    case 'del':  inner = '<button class="be-line-x" type="button" title="delete line">×</button>'; break;
    default:
      // Guards against exactly the failure mode flagged in review: uncommenting
      // a reserved LINE_COLUMNS entry (qty/rate/wht) without wiring its case
      // here would otherwise silently render the literal text "undefined".
      // Fail loudly instead — matches this file's existing load-error handling,
      // which explicitly avoids dying silently.
      throw new Error('renderCell: no case for column "' + col.id + '" — add one before enabling it in LINE_COLUMNS.');
  }
  return '<div class="bl-cell">' + inner + '</div>';
}
function addLine(data) {
  const container = document.getElementById('be-lines-body');
  const cols = activeColumns();
  const row = document.createElement('div');
  row.className = 'bl-row';
  // Grouped into two wrapper divs by tier (§3.2's "transaction facts" vs.
  // "coding facts" split) so Tier B (§3.4) can lay each group out as its own
  // independent flex row with no shared grid tracks to keep in sync. In
  // Tier A the wrappers are `display:contents` and disappear from the box
  // model, so their children become direct children of `.bl-row`'s grid —
  // relying on LINE_COLUMNS' tier-1-before-tier-2 invariant (§2.1) to keep
  // that flattened order matching `--bl-cols`.
  const g1 = cols.filter(c => c.tier === 1).map(c => renderCell(c, data)).join('');
  const g2 = cols.filter(c => c.tier === 2).map(c => renderCell(c, data)).join('');
  row.innerHTML = '<div class="bl-group">' + g1 + '</div><div class="bl-group">' + g2 + '</div>';
  container.appendChild(row);
  attachAcct(row.querySelector('.bl-acct'));
  if (VAT_ON) attachVat(row.querySelector('.bl-vat'));
  attachCenter(row.querySelector('.bl-cc'), 'cost');
  row.querySelector('.be-line-x').onclick = () => { row.remove(); updateTotals(); refreshAddRow(); };
  row.querySelectorAll('input').forEach(i => i.addEventListener('input', () => { updateTotals(); refreshAddRow(); }));
  refreshAddRow();
  return row;
}
```

Note the three new `placeholder`s on Amount, Cost center, and Expense account — they didn't need one before because the `<th>` header label was always visually adjacent. Once the layout can drop the header row at narrow widths (§3.4), every field needs to be self-labeling. This is a real, deliberate addition, not incidental.

### 2.4 Everything else that assumed `<tr>` — exhaustive list

Every other reference to the old table structure, confirmed by re-checking the current file directly (not from memory) before finalizing this table:

| Line(s) | Before | After |
|---|---|---|
| 79 | `tr:hover .be-line-x { visibility:visible; }` | `.bl-row:hover .be-line-x { visibility:visible; }` |
| 350 | `document.querySelectorAll('#be-lines-body tr')` (`lastLineHasData`) | `document.querySelectorAll('#be-lines-body .bl-row')` |
| 368 | `document.querySelectorAll('#be-lines-body tr')` (`collectLines`) | `document.querySelectorAll('#be-lines-body .bl-row')`, and the `.map(tr => ({...}))` callback's parameter renamed `row` (flagged in review — I'd caught the same rename for lines 363/587 but missed this one) |
| 363 | `tr.querySelector('.bl-desc').focus();` (add-row-button handler) | unchanged logic, `tr` var renamed `row` for clarity (cosmetic) |
| 569 | `document.querySelectorAll('#be-lines-body tr')` (FB.form zone `rows()`) | `document.querySelectorAll('#be-lines-body .bl-row')` |
| 587 | `var tr = api.zoneRows(1)[api.cur().r];` (delete verb) | unchanged logic, `tr` var renamed `row` (cosmetic — `.remove()` works identically on any Element) |

`cells: function (rowEl) { return ...rowEl.querySelectorAll('input,select,button')... }` (line 571–573) needs **no change** — already element-agnostic (§0.1).

One unrelated same-named class to leave alone: `.be-line-x` also appears at line 528 inside `renderAttachments()` (the staged-file delete button) — coincidental class reuse for "a small × button," not part of the line-items table. Don't touch it.

---

## 3. Row layout: don't pick one — make it a breakpoint

### 3.1 Why "single row or double row" is the wrong framing

Whatever fits comfortably in one row on a widened desktop screen (§1) will not fit in one row on a narrower window, and definitely won't fit on a phone. Picking one fixed layout optimizes for one screen size at the expense of the others. The column-config work in §2 makes this cheap to avoid: both the "columns" and their "areas" already exist as data, so which areas land in which visual row is a CSS media-query decision, not a markup decision — no JS branching needed.

### 3.2 Design against the field set #3/#4 will add, even though they're not built yet

This is the layout decision called out in the earlier conversation — worth making with the real shape in view. Anticipated full column set once #3 and #4 land:

Description · Qty · Rate · Amount · VAT code · WHT code · Cost center · Expense account · delete

Grouped by what they represent:
- **Transaction facts** (what was bought, how much): Description, Qty, Rate, Amount
- **Coding facts** (how it's booked): VAT code, WHT code, Cost center, Expense account, delete

That grouping is what drives §3.4's two-row split below — it's not an arbitrary column count cutoff, it's "what did you buy" vs. "how do you categorize it," which happens to also roughly balance the two rows' width once qty/rate/WHT exist.

### 3.3 Tier A — wide (default): one row

All CSS below lives inline in `bill-edit.js`'s own `<style>` block — see the corrected §7 for why (review caught that the original draft misrouted this to `common.css`, inconsistent with how the rest of the app does it).

```css
.be-lines-wrap, .bl-header, .bl-row { column-gap: 8px; }
.bl-header, .bl-row { display: grid; grid-template-columns: var(--bl-cols); }
.bl-header { font-size:9pt; text-transform:uppercase; color:#555; border-bottom:1px solid #ccc; padding:6px 6px 8px; }
.bl-row { border-bottom:1px solid #f0f0f0; padding:3px 0; }
.bl-group { display: contents; }  /* Tier A only — see §3.4 for the Tier-B override */
.bl-cell { padding:3px 4px; display:flex; align-items:center; min-width:0; }
.bl-cell input, .bl-cell select { min-width:0; width:100%; padding:4px 6px; border:1px solid #ddd; border-radius:3px; font-size:10pt; box-sizing:border-box; height:32px; }
.be-line-x { visibility:hidden; cursor:pointer; color:#999; border:none; background:none; font-size:12pt; padding:0 4px; }
.bl-row:hover .be-line-x { visibility:visible; }
.be-line-x.fb-form-cursor-btn { visibility: visible; }
```

`--bl-cols` is the custom property `applyGridColumns()` (§2.2) sets once on `#be-lines-wrap`; it inherits down to both `.bl-header` and every `.bl-row`, so there's exactly one place computing it. `.bl-group { display:contents }` makes the two tier-wrapper `<div>`s from §2.3 disappear from the box model in this tier — their children (the actual `.bl-cell`s) become direct grid items of `.bl-row`, positioned purely by DOM order against `--bl-cols`. (`min-width:0` on `.bl-cell` and its inputs matters and is easy to forget: grid children default to a minimum size based on their content, which can silently blow out a track — inputs in particular have a non-trivial intrinsic minimum width.)

This replaces the old `vatOn ? '36% 13% 13% 15% 21% 2%' : '36% 13% 15% 21% 2%'` duplication entirely — `computeWideColumns()` (§2.1) produces exactly as many tracks as `activeColumns()` has entries, so there is no unclaimed track and no gap.

### 3.4 Tier B — narrower viewports: two rows per line

```css
@media (max-width: 1100px) {
  .bl-header { display: none; }  /* see below — labels move to placeholders */
  .bl-row {
    display: flex;
    flex-direction: column;
    row-gap: 4px;
    padding-bottom: 8px;
  }
  .bl-group {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .bl-group .bl-cell { flex: 1 1 120px; }
}
```

Three deliberate choices here, not incidental:

1. **No shared grid between the two visual rows, on purpose — this is the actual fix for the empty-track bug, not just a side effect.** The original draft tried to keep both rows on one grid with computed spans (e.g. `desc`/`amt` each spanning two of four shared tracks) — that's real complexity that gets worse once #3/#4 change how many items are in each row, and it was the root cause of the reviewed bug. Making each `.bl-group` an independent `display:flex` row sidesteps needing spans (or a dynamically computed `grid-template-areas`) at all: each group simply lays out however many children it currently has, with nothing left over to render as a gap.
2. **The header row is hidden at this tier, not reflowed to match.** A single header row stops meaning anything once each line wraps into two visual rows of its own — trying to keep a matching two-row header just duplicates the same layout logic a second time for no benefit. This is exactly why §2.3 added placeholders to Amount, Cost center, and Expense account: once the header disappears, every field must already be self-labeling. Description and VAT code already had placeholders; the other three didn't need them before.
3. **1100px is a starting point, not a derived constant.** It's set to roughly where Tier A's `minmax()` floors (240+90+90+120+180+32px + gaps ≈ 830px content width) stop having comfortable breathing room inside a `page-wide` container, accounting for the page's 96px of horizontal padding. Treat it as something to eyeball and adjust during implementation/visual review — this spec isn't claiming a precisely derived number, just a sensible default.

One known trade-off worth stating plainly: `display:contents` (Tier A) has a documented quirk in some browser/assistive-tech combinations where the "disappeared" wrapper can also drop out of the accessibility tree along with its semantic role. Universally supported in evergreen browsers for the visual layout itself; flagged here for honesty, not treated as a blocker, since §5 already scopes ARIA/accessibility work out of this pass entirely.

### 3.5 Tier C — mobile/stacked: reserved, not built

Explicitly deferred (per the "eventually" framing in the earlier conversation), but the architecture above makes it a CSS-only follow-up, not a rearchitecture: a further breakpoint — matching the one existing precedent in the codebase, `company.js`'s `@media (max-width:700px)` — would set `grid-template-columns: 1fr` and `grid-template-areas` to one field per row, each already self-labeled via the same placeholders §3.4 introduced. Two things that tier will need to actually solve, flagged now so they aren't forgotten later, not solved here:

- **Hover-to-reveal delete buttons don't work on touchscreens.** `.be-line-x { visibility:hidden; } .bl-row:hover .be-line-x { visibility:visible; }` needs a non-hover affordance (always-visible on narrow layouts, most likely) before this genuinely supports mobile.
- **`FB.dropdown` autocomplete** (used for VAT/expense/cost-center pickers) hasn't been evaluated against touch input at all — out of scope for this spec, but a real gap between "renders on a phone" and "usable on a phone."

---

## 4. What is explicitly NOT part of this spec

- **No quantity/unit-price fields.** `LINE_COLUMNS` reserves the slots (commented out); the #3 spec fills them in and does the amount = qty × rate computation logic. This spec only proves the layout survives their arrival.
- **No withholding-tax field.** Same — reserved slot, `WHT_ON` flag doesn't exist yet, left to the #4 spec.
- **No Tier C (mobile stacked) implementation.** Seam reserved per §3.5, not built.
- **No `page-wide` rollout to other pages** (journal voucher, bank matching) — mentioned in §1.2 as a natural follow-up, not required here.
- **No ARIA/table-semantics work.** Moving off `<table>` loses the implicit tabular semantics screen readers get for free from `<th>`/`<td>`. Nothing in this codebase currently addresses accessibility beyond what native table markup provided incidentally, so adding `role="table"/"row"/"cell"` here would be scope creep relative to the app's current baseline — worth a future look, not blocking this refactor.

---

## 5. Rollout order

1. §2 (column-config extraction) first, on its own — this is a pure refactor with **zero visual change** if Tier A's CSS reproduces the current widths reasonably closely. Verify nothing regressed (line add/delete, VAT toggle on/off, keyboard nav across the `lines` zone) before touching layout.
2. §1 (`page-wide`) and §3 (responsive tiers) together — these are the actual visual changes, easiest to review as one diff since the breakpoint tuning in §3.4 depends on how much width §1 actually reclaims.
3. Manually resize the browser window across the Tier A/B boundary and confirm: no console errors, keyboard cursor (`FB.form`) still lands on the right cell after a resize, delete (`x`) and add (`a`) verbs still work in both tiers, VAT-off companies render correctly in both tiers (no leftover empty `vat` grid area).

---

## 6. Acceptance criteria

1. No column width is hand-typed as a percentage anywhere in `bill-edit.js`; `LINE_COLUMNS` is the only place a column's existence and label are declared.
2. Toggling `vatOn` adds/removes the VAT column consistently in the header and every row, in both Tier A and Tier B, with no dangling empty grid track — verify concretely by inspecting computed styles on a VAT-off company: `--bl-cols` (§2.1) must contain exactly as many space-separated track sizes as `activeColumns()` returns entries, not one more.
3. At viewport widths above the Tier A/B breakpoint, line items render as one row each, matching (or improving on) current visual density.
4. At viewport widths below the breakpoint, line items render as two rows each, with no header row, and every field is legible without relying on a header label.
5. `FB.form` keyboard navigation (`j`/`k`/`i`/`x`/`a`/Tab) across the `lines` zone works identically to before at both tiers — confirmed by the existing manual keyboard-nav check, not just visually.
6. The bill editor's page content visibly uses more of the browser width than before on a standard wide desktop viewport (e.g., 1440px+).
7. No other page's layout changes — `page-wide` is additive and opt-in.

---

## 7. File-by-file change list

**Corrected from the original draft** (review caught that it routed page-specific rules to the wrong file): `common.css` only ever gets the one-line `.page-wide` modifier, since that's a modifier on a rule `common.css` already owns. Every `.bl-*`/`.be-line-x`/`@media` rule stays inline in `bill-edit.js`'s own `<style>` block — matching how `.be-lines` lives there today, and how `company.js` keeps its dashboard CSS (including its one `@media` block) inline rather than in `common.css`.

| File | Change |
|---|---|
| `api/public/common.css` | Add `.page.page-wide { max-width: min(94vw, 1600px); }` (§1.2). Nothing else in this file changes. |
| `api/src/pages/bill-edit.js` | Change page wrapper to `class="page page-wide"` (§1.2). In the inline `<style>` block: **delete** the existing `table.be-lines`, `table.be-lines th`, `table.be-lines td`, `table.be-lines input, table.be-lines select`, and `tr:hover .be-line-x` rules; **add** the `.be-lines-wrap`/`.bl-header`/`.bl-row`/`.bl-group`/`.bl-cell`/`.be-line-x`/`.bl-row:hover .be-line-x` rules plus the `@media (max-width:1100px)` block (§3.3, §3.4). `.be-line-x.fb-form-cursor-btn` is unchanged, carries over as-is. In the script: replace `<table class="be-lines">`/`<thead>` markup with the `#be-lines-wrap` shell (§2.2); add `LINE_COLUMNS`, `WIDE_TRACK_WIDTH`, `activeColumns()`, `computeWideColumns()` (§2.1); add `renderLinesHeader()` + `applyGridColumns()`, called once at init (§2.2); rewrite `addLine()`/`renderCell()`, including the new `default` case (§2.3); add placeholders to `.bl-amt`/`.bl-cc`/`.bl-acct`; update every `tr`-based selector per the §2.4 table, including the `collectLines` callback param rename. |

No changes to any backend file — this is a rendering-only spec.
