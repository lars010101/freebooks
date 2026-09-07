# UI / UX Philosophy

This document defines the design and accessibility standards for freeBooks UI. All contributors should follow these guidelines.

**Status:** revised 2026-09-06 after an audit found the previous version (2026-05-05) diverged from ~80% of shipped screens on its two central rules (font-size units, colour theming). That version was written once and never checked against the app again. This revision:
- keeps the rules the audit found were actually correct,
- corrects the ones that were wrong for this product (the 16px body-text floor; `title` over `aria-label`),
- adds what was missing and is why redesigned screens would otherwise fail to look like siblings (spacing scale, component inventory, button hierarchy, posted-vs-draft language).

If you find yourself violating a rule below because the tokens/components to do it right don't exist yet, that's a bug in this document — flag it, don't route around it with a hardcoded value.

`common.css` and every page file under `api/src/pages/*.js` (plus `api/public/fb-core.js` and `common.js`) were brought into full conformance with this revision on 2026-09-06 — zero `pt`/`px`/`em` font-sizes, zero hardcoded hex colours outside a `:root`/`[data-theme="dark"]` block, verified by repo-wide grep and a syntax check of every touched file. `common.css` is the reference implementation: if a page contradicts it, the page is wrong. Two things this pass deliberately did *not* do: it didn't unify the three status-chip class vocabularies (`st-badge`, `badge-*`, `.chip`) into the single component named in the Components section below — each file's existing classes were pointed at the semantic tokens in place, so a page still needs its markup migrated to adopt the unified `fb-chip` component when that work happens; and it left off-scale `rem` values (e.g. `0.833rem`, `1.083rem`) alone where they weren't `pt`/`px` — normalizing those onto the exact scale above is cosmetic tidying, not a rule violation, and wasn't in scope.

---

## Purpose

freeBooks is used by bookkeepers, owners, and auditors working through volume — ledgers, batches of bills, reconciliations. The UI optimizes for **speed, trust, and auditability**, in that order of frequency but not of importance. It is not optimized for delight. A screen that lets an accountant verify 40 rows without scrolling is doing its job better than one that looks nicer with 12.

---

## Typography

### Core rule: `rem` for font sizes

All font sizes use `rem` units. Never use `pt` or `px` for font sizes. `em` is acceptable only when a value must scale with its *own* element's font-size (e.g. icon sizing relative to an adjacent label), not as a general substitute for `rem`.

`rem` is relative to the root `<html>` font size, so it respects the user's browser/OS default-font-size preference. (It does **not** uniquely respect browser zoom — `Ctrl +`/`Cmd +` scales `px` and `pt` identically. The real reason to use `rem` is the OS/browser default-size preference, not zoom.)

```css
:root {
  font-size: 100%; /* respects the user's default-size preference */
}
body {
  font-size: 0.8125rem;
  line-height: 1.6;
}
```

### The type scale is dense on purpose

This is ledger software: the primary task on most screens is scanning many rows at once (a journal batch, a reconciliation, an aging report), and fitting more of that batch in one viewport is a correctness aid, not just a density preference — it's easier to spot an anomalous row when more of the set is visible together. The scale below is deliberately smaller than a typical marketing-site or consumer-app minimum, and that is intentional, not a shortfall to fix.

| Role | rem | ~px at 16px root | Notes |
|---|---|---|---|
| Page heading (h1) | `clamp(1.375rem, 1.5vw + 1rem, 1.833rem)` | 22–29px | fluid, see below |
| Section heading (h2) | `clamp(1.25rem, 1.25vw + 0.875rem, 1.667rem)` | 20–27px | fluid, see below |
| Sidebar company name | `1.125rem` | 18px | |
| Emphasis / large numeric total | `1rem` | 16px | e.g. a report grand total — use sparingly, this is the *largest* body-adjacent size, not the default |
| Sidebar nav items | `0.917rem` | ~15px | |
| Top-bar nav links / buttons | `0.875rem` | 14px | |
| **Body text / table cells (default)** | **`0.8125rem`** | **13px** | the working default for grids, forms, lists |
| Sub-labels / captions / secondary table text | `0.75rem` | 12px | |
| Small labels (uppercase), dense micro-text | `0.6875rem` | 11px | |
| Decorative carets | `0.625rem` | 10px | |

Numeric/money cells additionally get `font-variant-numeric: tabular-nums` — apply it once, on a shared utility class (e.g. `.fb-num`) or the table's numeric-column selector, not inline per cell. Misaligned decimal columns are a legibility defect in this domain: scanning a column of totals for an outlier depends on digits lining up. Money is right-aligned, fixed decimal places, never wraps.

### Fluid headings: `clamp()`

Headings use `clamp()` so they scale smoothly without a media query and never get comically large on an ultra-wide monitor. This only applies to `h1`/`h2` — it is not a general pattern for body or table text, which stays at the fixed sizes above.

```css
/* clamp(minimum, fluid-middle, maximum) */
/* min/max must be rem (WCAG 1.4.4: supports 200% zoom); vw belongs only in the middle term */
h1 { font-size: clamp(1.375rem, 1.5vw + 1rem, 1.833rem); }
h2 { font-size: clamp(1.25rem,  1.25vw + 0.875rem, 1.667rem); }
```

### Font family

`'Helvetica Neue', Arial, sans-serif` everywhere. This is the only approved stack — don't declare a page-local font-family or `!important` override it; if a page currently does, that's a cleanup target, not a precedent to extend.

### Rules
1. **`rem` (or `em` for self-relative cases) for font sizes.** No `pt`, no fixed `px`.
2. **`rem` for clamp bounds.** The `vw` component belongs only in the fluid middle expression.
3. **Max ≤ 2.5× min** on any fluid/clamped size (WCAG 1.4.4).
4. **Tabular numerals on all monetary/numeric columns**, applied via a shared class, not inline.
5. **Negative numbers, decimals, and currency placement** follow one convention across the app (to be pinned down as part of the Components pass below — currently inconsistent; don't invent a new convention per-screen).

---

## Density

Two modes, not a spectrum:

- **Compact (default).** Table rows and table-embedded inputs use the smaller end of the spacing scale below. This is what ships by default everywhere — accounting users want more rows on screen, not more air around them.
- **Comfortable (optional).** Uses the larger end of the spacing scale.

Don't introduce a third density or per-screen bespoke spacing — every screen picks one of these two.

**Shipped 2026-09-06** as a global, user-level toggle (not per-screen) — a topbar button (`fbToggleDensity()`, `common.js`) matching the existing theme toggle's exact mechanism: a `data-density="comfortable"` attribute on `<html>` (absent = compact), persisted per-browser via `localStorage` (not per-company — it's a reading preference, not company data, same reasoning as the theme toggle). The CSS lives once in `common.css` rather than duplicated across the eight files that define the dense edit-grid archetype (`.edit-table`/`.jrnl-table`/`.jv-table`), overriding all eight by selector specificity.

Scope: only the dense edit-grid archetype (table cells + their embedded inputs) responds to this toggle. Standalone form fields and the `.data-table` browse-list archetype are deliberately excluded — standalone fields already sit at the scale's single "8px 12px" value with no cramped variant to relax from, and `.data-table` is already the roomy archetype (see Spacing scale); toggling density is about giving the *dense* archetype a break, not making the already-comfortable one more so.

If a table-embedded input ever doesn't respond to this toggle, look for an ID selector styling it directly (an ID always outranks the `[data-density="comfortable"]` override's specificity, no matter how many classes that override stacks) — `calendar.js`'s `#reminder-add-row input` was exactly this, and turned out to be fully redundant with the shared `table.edit-table input[type=text]`/`[type=date]` rule already in the same file, so the fix was deleting the ID rule, not adding a bigger override.

---

## Spacing & Layout

Use `px` (or unitless/relative values where CSS requires it) for padding, margin, border-width, and gap — not `rem`. Spacing shouldn't track the user's font-size preference the way text does.

### Spacing scale

```
4px · 6px · 8px · 12px · 16px · 24px
```

Pick from this scale; don't introduce arbitrary values.

**Enforced as of 2026-09-06** — the app previously had two verbatim-duplicated table stylesheets (`.edit-table`/`.jrnl-table`/`.jv-table` across 8 files; `.data-table` across 2) whose `td` padding had drifted into 4 different values despite `th` staying identical everywhere. Normalized onto two intentional, named archetypes instead of one drifting default:

| Element | Dense (edit grids — `.edit-table`, `.jrnl-table`, `.jv-table`) | Roomy (browse lists — `.data-table`) |
|---|---|---|
| Table cell padding (td and th) | `4px 6px` (th: `6px 6px`) | `12px 12px` |
| Table-embedded input padding | `4px 6px` | — |
| Standalone form field / toolbar input padding | `8px 12px` | |
| Section/card padding | `12px` (compact) – `24px` (comfortable) | |

Table row min-height is deliberately **not** set explicitly — rows currently derive their height from padding + line-height + font-size, which already renders consistently within each archetype above, and inventing an explicit min-height without a concrete problem to fix risks making rows *less* consistent, not more. Revisit only if a real height mismatch turns up.

The dense/roomy split itself is intentional, not a residual inconsistency: dense edit grids (journal lines, chart of accounts, settings tables) prioritize scanning many rows; `.data-table` browse lists (Payables, Bank) carry avatars, badges, and hover row-actions that need the extra room. Don't blindly force one archetype's padding onto the other — pick whichever this screen's job actually calls for, matching one of the two rows above exactly, not a value in between.

### Structural constants

- Top bar height: fixed `52px` — intentional chrome, not part of the density scale.
- Page content max-width: `1100px`. Reference the shared constant/class — don't re-declare the literal per-page.

### Layering

**Verified against real usage 2026-09-06** — the scale originally proposed here (round numbers: dropdown 100, modal 1000, etc.) was never checked against the actual codebase and didn't match it. The real scheme, it turns out, is already coherent and mostly deliberate; the fix here is to this document, not to the code. (The topbar-icon-dropdown stacking bug referenced in the previous version was an Escape-key/multiple-dropdowns-open state bug, not a z-index ordering problem — already fixed separately, unrelated to the numbers below.)

```
sticky table header (.data-table thead)                          : 10
topbar chrome (#top-bar)                                         : 90
topbar popover (company switcher, period picker)                 : 300
topbar dropdown (notifications, download, + New menu)             : 1000
keyboard-shortcut overlay (#fb-keys-overlay, the `?` help panel)  : 9500
modal / dialog (FB.modal)                                         : 9800
dropdown / autocomplete / command palette / column filter          : 9999
  (.fb-dd, .fb-palette, .fb-grammar-hint, .fb-col-filter-dd)
```

The last tier being *highest*, above modals, is intentional and documented in common.css where `.fb-modal-overlay` is defined: dropdowns need to render correctly even when nested inside a modal (an autocomplete field inside a modal form, say), so they stay on top of everything, modals included, rather than getting clipped beneath the modal that hosts them. Don't "fix" this into a more conventional-looking modal-on-top ordering — that would break dropdowns-inside-modals.

New chrome should slot into one of these seven tiers by role, not invent an eighth. If something doesn't fit the categories above, that's worth a real conversation about why, not a guessed number.

---

## Colour & Theming

All colours use CSS custom properties (`var(--name)`). **Never hardcode a colour value outside a `:root` / `[data-theme="dark"]` block.** This is the most important rule in this document — light and dark themes are both defined and dark mode is a shipped, user-facing feature (topbar toggle, persisted), not a nice-to-have. Any new UI element must work correctly in both.

This rule only works if the token set actually covers what you need. It didn't — that's why ~600 raw hex values exist in the codebase today, standing in for colours (status/danger/success/warning/info, table stripe, input borders, focus rings) that had no token. Adding a new semantic token is the correct fix when you hit this gap; hardcoding a hex value is not.

### Token set

**Shipped in `common.css`** as of the 2026-09-06 remediation pass:

- Existing chrome tokens (`--bg`, `--surface`, `--border`, `--text`, `--text-muted`, `--text-faint`, `--sb-*`, `--tb-*`, `--navy-*`, `--accent`, `--dd-active`, `--toggle-on*`) stay as before, with `--text-muted` corrected in the light theme (`#6b7a95` → `#5f6e89`, fixing a 4.34:1 AA failure — now ≥5:1). `--text-faint` was left failing AA on purpose; see Usage notes.
- `--on-accent` (`#ffffff` in both themes) — text/icons on an `--accent`-filled surface (buttons, the keyboard-focus cursor row). Not in the original proposal; needed once the `#fff`-on-dark-fill literals scattered through `common.css` were being replaced.
- `--focus-ring` (`#2563eb` light / `#93c5fd` dark) — see Accessibility.
- Semantic status tokens, each with a `-bg` and `-border` pair: `--danger`, `--success`, `--warning`, `--info`, and a neutral `--chip-text`/`--chip-bg`/`--chip-border` trio for non-status tags. Values were chosen interactively (contrast-checked against `--surface` in both themes) and seeded from hex values already in use across `api/src/pages` rather than invented from scratch — see the status-chip vocabulary in Components below for how they map to the app's actual status labels.

**Proposed but not needed in practice:** `--row-stripe`, `--row-hover`, `--input-bg`, `--input-border`, `--input-border-focus` were expected to be necessary but weren't — the existing `--bg`, `--border`, and `--surface` tokens already covered every row-hover and form-input case encountered while remediating `common.css`. Introduce a dedicated token only if a real case turns up that these three can't express; don't add them speculatively.

### Usage notes
- `--text-faint` is for **decorative-only** elements (carets, dividers) that don't need to pass text contrast — never use it for text a user is expected to read. If a caption or label needs to be muted but legible, use `--text-muted`.
- Don't invent a one-off hex value because "it's close enough to an existing token" — extend the token set instead, so both themes stay in sync automatically.

---

## Components

freeBooks already has a de-facto shared component layer (`fb-core.js`, `fb-list.js`, `fb-form.js`). This section names the conventions that layer should converge on; it documents intent, not a finished inventory — expect to extend it as screens are redesigned, but extend it here, not per-page.

- **Table.** Right-aligned numeric columns (tabular numerals, per Typography), sortable/filterable headers, sticky header on scroll, row density per the Density section, zebra via `--row-stripe`, batch actions in a visible bar above the table — not hidden in an overflow menu, inline row actions on hover/focus.
- **Filter / toolbar bar.** Sits above the table it filters. Filters are visible, not collapsed behind a single "Filters" button, unless the filter count genuinely doesn't fit.
- **Status chip.** One vocabulary, shipped: `.badge` (base shape, `common.css`) plus five semantic modifiers — `.badge-danger`, `.badge-success`, `.badge-warning`, `.badge-info`, `.badge-neutral`. This replaced five independent per-page conventions on 2026-09-06 (`st-badge`/`st-*` in journal-voucher.js and inbox.js, `.badge-out`/`.badge-in`/`.badge-manual`/`.badge-bank_match`/`.badge-voided`/`.badge-posted` in bank.js/bank-payments.js, and three separately-defined bare `.badge` classes with mismatched geometry in bank.js/payables.js/bill-edit.js — two of which, in `payables-bills.js` and `payables-partners.js`, had no definition backing them at all and were rendering completely unstyled). What each page's own status values *mean* (which of the five buckets "voided" or "overdue" maps to) stays local to that page; only the rendering classes are now shared. New status badges use `class="badge badge-<semantic>"` — never a sixth vocabulary, and never an inline `style="background:...;color:..."` on a badge, which is exactly the pattern that left two pages unstyled last time.
- **Action-icon chip vs. filter/tag chip — two components, deliberately not one.** `.chip`/`.chip-ok`/`.chip-cancel`/`.chip-disabled` (common.css) is the row-verb affordance: fb-list.js's write (✓) / revert (✕) / exit (✕) on a dirty row, and a page's own approve/reject/view/delete/post/discard/retry icons. `.fb-tag` (common.css) is a labelled, bordered toggle or small action link ("+ Add reminder", "+ Upload document", "Save", "Cancel", "Open", "Delete" as text, not a glyph). **Shipped 2026-09-06** — both names had been `.chip` across different files, colliding, and the consequence wasn't just naming confusion: `.chip-ok`/`.chip-cancel` had **no colour rule anywhere in the codebase**, so every write/revert/approve/reject icon on every page using them (8+ FB.list pages, plus inbox.js's row verbs) rendered with no colour at all until this fix. New icon-only row verbs use `.chip` + `.chip-ok`/`.chip-cancel`/`.chip-disabled`; new labelled toggles/links use `.fb-tag`. Don't reuse `.chip` for a labelled link again — that's exactly how this happened.
- **Empty / loading / error states.** Consistent copy tone, consistent placement (centered in the content area the data would otherwise occupy), consistent use of `--text-muted`. Not ad-hoc inline strings styled per-screen.
- **Confirmation.** Destructive or hard-to-reverse actions (void, delete, post a period-locking entry) get an in-app confirmation component (`FB.modal`) that can show *what* is about to happen — not a bare `window.confirm()`. **Shipped 2026-09-06** — all 15 real `window.confirm()` call sites migrated. One thing to watch: `FB.modal`'s `title` is escaped internally, but its `body` is raw HTML (to allow legitimate formatting) — always `esc()` any interpolated value (a partner name, a filename) that lands in `body`, the same way you already would before concatenating it into any other HTML string.
- **Buttons.** One primary action per view. Primary / secondary / tertiary / destructive variants, all driven by tokens (no more hardcoded `#1a1a1a` primary button background). Destructive buttons use `--danger`.
- **Posted vs. draft.** The single most domain-specific requirement: an immutable/posted document must be visually distinguishable from an editable draft, consistently, on every screen that shows either state — this is an auditability requirement, not a styling preference. **Shipped 2026-09-06**, two parts:
  1. `.fb-locked-fields` (common.css) — toggle this class on a field container once a record becomes non-draft/locked; it flattens inputs/selects/textareas to plain, borderless, muted-color text. Used by journal-voucher.js and bill-edit.js's header fields; line-item grids that individually `.disable` each input (bill-edit.js's `.bl-cell`) get the same look via native `:disabled` instead, which is fine — the visual outcome is what has to match, not the mechanism. If you're adding this to a page whose fields already have their own `:disabled`/`[readonly]` background override (there was exactly one such collision, in journal-voucher.js, from an unrelated disabled-state rule predating this component), add a same-shape compound override *in that page's own stylesheet* rather than fighting it from common.css — see journal-voucher.js's comment at the `.fb-locked-fields` block for the worked example.
  2. A 🔒 prefix on the status badge text itself for every status that represents a locked/immutable state (posted, void, reversed, paid, partial, overdue — everything except an editable draft/proposed/new). This is a second, non-color-dependent signal, not decoration: colour alone silently excludes colourblind users from "is this locked" being scannable at a glance. Implemented in journal-voucher.js's `updateStatusBadge()` and bill-edit.js/payables-bills.js's `statusBadge()`.

  Not yet touched: any other editable-then-postable record type introduced later should reuse both parts rather than inventing a per-page equivalent — that's exactly how this became five inconsistent conventions the first time.

---

## Accessibility

- **Contrast:** WCAG AA — 4.5:1 for body text, 3:1 for large text (≥1.5rem or ≥1.125rem bold). This applies to token *and* hardcoded colours alike — a token doesn't get a pass just for being a variable. `--text-faint` is exempted only because it's restricted to decorative, non-text use (see Colour & Theming).
- **Focus:** interactive elements must have a visible `:focus-visible` state using `--focus-ring` — not `:focus` alone (which also fires on mouse click) and never `outline: none`/`outline: 0` without a replacement ring. Keyboard navigation is a primary input mode for fast data entry here, not an edge case.
- **Hover:** interactive elements also get a `:hover` state, but hover is a supplement to focus, not a substitute for it.
- **Disabled / placeholder elements** use `opacity: .4` or `cursor: not-allowed` — do not remove them from the DOM.
- **Icon-only buttons** get an `aria-label` (a `title` attribute may be added additionally for a mouse-hover tooltip, but `aria-label` is the accessible name and is required — `title` alone is not a reliable substitute for screen readers).
