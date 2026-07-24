# FB.list UX Spec — the one list machine

Status: **RATIFIED 2026-07-23** (magnus, Slack design thread). Supersedes the ghost-row create slot (rejected same date). Companions: `settings-ux-spec.md` (Esc doctrine origin — §3 restates, does not revise it), `payables-ux-spec.md` (Bills tree-table; migrates onto FB.list last).

---

## 1. Purpose

One component — `FB.list` (`api/public/fb-list.js`) — owns ALL behavior for every flat register in the app: the add row, navigation, edit lifecycle, dirty buffers, delete, leave-guard. A screen declares columns + actions + a handful of predicates; it implements **no interaction code of its own**. Behavior therefore cannot drift between tabs.

**Migrated:** Settings (Periods, COA, Tax Codes, Journals), Vendors, FX Rates.
**Pending:** Bank Mappings; Bills (needs `tree: true` — fold is a *property*, not a separate universe). The Bills *editor* screen stays separate (grid vs form is legitimate).

## 2. The add row (single create affordance)

A plain muted text row pinned at the **bottom** of the list, reading `+ Add entry` (config `label`) — one td spanning all columns, dashed top border, pointer cursor. **Not** an input replica: the grayed-out replica ("ghost row", 2026-07-22) read as a fake row and was rejected by magnus 2026-07-23. Industry reference: QuickBooks "Add lines", Xero "Add a new line".

- **Reachable by:** click; `j` (sticky past the last data row); `G` (bottom). `gg` returns to the first row.
- **`i` / Enter / click** on it: the add row transforms in place into the live navy edit row (INSERT mode, first field focused). It is hidden while a NEW row is being edited and reappears on exit.
- New and dirty-new rows **append at the bottom**, right above the add row — creation grows from the bottom, where the eye already is.
- `o` is **retired** on FB.list screens (the add row is the only create path). `o`/`O` remains "new master object" on Bills until its migration.

## 3. Row lifecycle (doctrine restated from settings-ux-spec §1)

**Esc never saves.** Exactly one save path: `w`.

```
clean ──i/Enter/click──▶ editing ──Esc──▶ dirty ──w──▶ clean (saved)
                            │             │
                            │             └──u──▶ clean (reverted)
                            │
                            └── Esc on an untouched NEW row ──▶ vanishes;
                                cursor returns to the add row
```

- Read-first: rows render as text; edit mode turns ONE row into inputs. Typing touches the in-memory buffer only.
- **Enter never saves** — in INSERT it advances fields (sticky ends); Tab / Shift+Tab the same.
- Dirty row: amber indication; `x` on a dirty-new row discards it (cursor → add row).
- After Esc-blank or discarding a new row, the cursor lands on the **add row**, not the top of the list.

## 4. Verb table (every FB.list screen)

| Mode | Key | Action |
|---|---|---|
| read | `j`/`k` | navigate rows, sticky ends; the add row is a nav position (bottom) |
| read | `gg` / `G` | first row / bottom (= add row) — framework-level since 2026-07-23 |
| read | `i` / Enter / click cell | edit focused row; on the add row = create |
| read | `x` | delete — confirm for saved rows; no-op on `deletable:false` rows (e.g. ECB rates); discards dirty-new rows |
| read, dirty | `w` / `✓` chip | **write — the only save** |
| read, dirty | `u` / `✕` chip | revert to saved values |
| edit | Enter / Tab / Shift+Tab | next / prev field, sticky ends — never saves |
| edit | Esc | dropdown open → close dropdown; otherwise exit to read, buffer stays dirty |
| any | `h`/`l` · `{`/`}` · `?` | shared chrome via common.js / FB.keys |

Screen-specific verbs live in `extraBindings(api)` (e.g. Vendors `~` toggle active) — nowhere else.

## 5. Verb convention (app-wide, ratified 2026-07-22)

- `o`/`O` = **new** master object (opens a new top-level entity — bill on Bills).
- `a`/`A` = **add** child to an existing parent (bill line, attachment).
- On master-only FB.list screens `a` is unbound; create is the add row's job.

## 6. Config contract

| Option | Meaning |
|---|---|
| `keysId` / `active()` | FB.keys registration name; tab-visibility predicate |
| `tbody` | table body element id |
| `companyId()` | company id for `/api/action` payloads |
| `columns[]` | `field` (buffer property + input class), `type` (`text`/`date`/`number`/`checkbox`/`select`), `width`, `align`, `ro` (`'saved'` = key column read-only on saved rows; `'always'` = display-only), `uppercase`, `step`, `options` (`''` renders `- none -`), `nullable`, `display(v,row)` (view-mode HTML), `attach(input,tr)` (post-build hook — FB.dropdown attachers) |
| `blank()` / `isBlank(b)` | new-row defaults; untouched-new predicate (vanish on Esc) |
| `same(b,s)` | buffer matches saved row → dirty dropped |
| `validate(d)` | error string \| null — runs on `w`, failure keeps the buffer |
| `editable(d)` / `deletable(d)` | row predicates (default true) — false = never enters edit / `x` no-op (ECB rates) |
| `rowStyle(d)` | cssText for the `<tr>` (e.g. ECB dim) |
| `firstField(isNew)` | field to focus when entering edit |
| `track` | FB.track.create name (optional) |
| `label` | add-row text (default `+ Add entry`) |
| `list` | `{ action }` or `{ url }` + `map(raw)` → saved row incl. `_key` |
| `save` | `{ action, body(d), focusKey(d,res) }` |
| `del` | `{ action, body(d), confirm(d) }` \| null |
| `onChrome(anyDirty)` | tab dot / dirty bookkeeping (optional) |
| `onLoaded(saved)` | post-load hook (e.g. compat globals) (optional) |
| `focusClass` / `onFocus(tr)` | nav highlight class (default `nav-row-focus`); focus hook (optional) |
| `extraBindings(api)` | screen-specific NORMAL bindings (optional) |
| `filter(row,q)` | enables `api.setFilter(q)` (optional) |

**Status messages (retired 2026-07-23):** the per-screen `msg` span config is gone. All transient feedback ("Saved", validation errors) routes through **`FB.status.show(text, sev)`** (fb-core) into the single topbar slot `#tb-status-msg`. Severity: `true`/`'err'` red, `'warn'` amber, falsy green/neutral. **Never auto-dismisses** — a message stays until the next one replaces it (vim cmdline semantics). Distinct channel from the 🔔 (persistent alerts, fx-automation-spec §7).

## 7. Extensions inventory (added for Vendors/FX, 2026-07-23)

- `attach` — per-column post-build hook (CCY/account dropdown pickers).
- `ro: 'always'` — display-only column in both modes (Active badge, FX source).
- `editable(d)` / `deletable(d)` — FX ECB rows are read-only and undeletable.
- `rowStyle(d)` — ECB rows dimmed.
- `extraBindings` / `focusClass` / `onFocus` — screen verbs + compat globals (`fbVendorSelRow`).

## 8. Filtering — one pattern, two paths

**Status 2026-07-23 (rev. 2): filter design agreed with Magnus; keyboard path revised to the unified topbar model (no framework command box) after live feedback. G/gg on FB.list screens scroll #page-main to absolute bottom/top (Bills parity).** Per-column filtering is a framework feature, declared per column. The Bills `≡` implementation is the reference UX; it is **deleted — not ported — when Bills migrates to FB.list** (see §11 backlog).

**2026-07-24 (rev. 3): sensible default.** Columns are now **filterable by default** — at list init, any column whose `filterType` is still `undefined` gets `'text'`. Checkbox columns default to **non-filterable** (`null`) — the framework has no boolean filter UI yet, so a text box against a checkbox would be noise. A screen opts an individual column out by declaring `filterType: null` (the existing truthiness checks throughout the module honor it). Screens therefore declare only the **special** types — `'list'`, `'date'`, `'amount'` — where the column semantics call for them; redundant `filterType: 'text'` declarations were removed from every audited screen.

**One filter state, two ways to drive it:** a per-column dropdown (mouse) and the topbar search input (keyboard) render the same filter state; editing either updates the other.

### Column config

Optional `filterType` per column (addition to the `columns[]` config in §6). The default is `'text'`; screens declare only the special types and opt out with `null`:

| `filterType` | Dropdown control |
|---|---|
| `'text'` *(default)* | single text input — case-insensitive substring match |
| `'date'` | date input with on / before / after operators |
| `'amount'` | operator (`>`, `<`, `=`, `≥`, `≤`) + value |
| `'list'` | scrollable distinct-values list, headed by "All (clear filter)" |
| `null` | column is non-filterable (explicit opt-out; also the auto-default for `type: 'checkbox'`) |

New optional screen-level `hint: 'string'` renders register notes in the sidebar under that tab's keyboard help — the **only sanctioned location** for register notes (no bespoke paragraphs under tables).

### Mouse path — the ≡ dropdown

An `≡` button is absolutely pinned to the right corner of every filterable column header. Clicking it opens the type-appropriate dropdown (table above). While a filter on that column is active, the header shows the active filter state and the filter controls stay visible.

### Keyboard path — the topbar (unified search, revised 2026-07-23)

**One input for everything.** `/` focuses the topbar global search — always, on every screen (the framework no longer renders its own command box; the topbar IS the box). Scope is expressed by the value's leading character:

- **Value starts with `/`** → **screen-limited filter expression**, routed to the visible FB.list (`FB.list.visible()`). So `//` starts a screen filter. Plain terms + the full qualifier grammar apply. The list re-filters live as you type.
- **Anything else** → the **global search** (app-wide; the future scope Magnus flagged — no separate scope toggle needed, the prefix IS the scope).

Mirror rules (one state, two views): ≡ dropdown edits write `/expression` into the topbar **when the user is not typing in it**; `c` clears filters AND the mirror; Esc in the topbar clears value + filters + blurs; Enter keeps the filter and blurs. Deleting the leading `/` disengages the screen filter (clears it) — the transition out of filter context is explicit user intent.

### Grammar

- Plain terms = case-insensitive cross-column fuzzy row filter. This **supersedes all per-screen search boxes** (e.g. COA's `#coa-search`) — screens stop rendering their own filter inputs; the existing `filter(row, q)` predicate config (§6) remains the mechanism plain-text mode drives when declared (otherwise the framework auto-matches across all column fields).
- Qualifiers `field:value` filter one column.
- Operator syntax: `amount:>100`, `date:<2026-07`.
- Multiple terms/qualifiers AND-combine.

### One filter state, two views

Dropdown choices and the topbar expression are two renderings of the same filter state; editing either updates the other.

### Verbs

- **`c` clears all filters** (established verb from Bank).
- **NORMAL-mode `Esc` peels one layer, never writes:** open ≡ dropdown → close it; active filters → clear them; otherwise inert. (INSERT-mode Esc is unchanged: exits edit, dirty buffer stays — "Esc never saves" governs row data; filters are view state.)
- **Edit/dirty rows always bypass filters:** a row in edit mode — including the freshly created add-entry row — is never hidden by the active filter. After `w` the row re-submits to the filter (and vanishes from view if it no longer matches — correct).
- **List-level actions:** non-row-editing register actions (e.g. Fetch Rates) may be declared as list-level verbs — a key plus one small button in the list header for mouse parity. They must not edit existing rows.

## 9. Leave-guard

One shared modal per page across all mounted FB.list instances: switching tab/page or sidebar-navigating with any editing-or-dirty row opens **Save / Discard / Stay**. Save = write all dirty rows, proceed only when all succeed; Discard = revert all, proceed; Stay = abort. Hooks: the page's own tab-switch function, `window.fbBeforeTabSwitch` (common.js `{/}` path), and a capture-phase sidebar click handler (mouse parity).

## 10. Bills — Option A (interim doctrine, 2026-07-22)

Until Bills migrates onto FB.list (`tree: true`), its bespoke `_insertEscape` follows the same doctrine: **Esc exits INSERT only** — a non-empty inline draft stays as a DOM-marked dirty buffer (`fb-draft-dirty`); `w` persists it (zero drafts server-side until then). Esc on an empty draft discards it.

## 11. Migration backlog (in order)

1. **Bank Mappings → FB.list.** Then delete the legacy `.fb-ghost-row` CSS (kept only for bank.js) and the `activateMappingGhost` machinery.
2. **Column filters + command box into FB.list** (§8). Landing filters first means Bills' ~450 lines of bespoke filter code are deleted, not ported.
3. **Bills → FB.list with `tree: true`.** Fold/unfold becomes a row property of the same machine; the bill editor screen stays separate. Last bespoke list surface in the app.
4. **Receivables** built on FB.list from day one (roadmap P3-1).

## 12. Testing contract

- API side unchanged: contract tests (`npm test` in `api/`) cover actions, not pixels.
- Per migration: live browser verification of the framework cycle on ONE representative screen is sufficient — the behavior is shared code. Cycle: create-from-add-row → Esc-blank vanishes → create → Esc-dirty → `w` lands server-side. Plus screen-specific extras only (dropdown attachers, read-only predicates).
