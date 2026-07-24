# Settings UX Spec — modal edit doctrine + grid migration

Status: **RATIFIED 2026-07-22** (magnus, Slack design thread). Pilot: **Periods tab**. Companion to `payables-ux-spec.md`; where they conflict, this doc wins (it post-dates and revises the Payables Esc doctrine — see §7).

**Update 2026-07-23:** the pilot pattern is now app-wide — every flat register runs on the shared **FB.list** machine, and the create slot changed (`o` retired → bottom `+ Add entry` row). See **`fb-list-ux-spec.md`** for the add-row design, full verb table, config contract, and migration backlog. The lifecycle doctrine below (§1–§2) is unchanged and restated there.

## 1. Core doctrine

**Esc never saves.** Esc exits edit mode; the row's unsaved changes stay in memory as a *dirty buffer* (vim's file/insert/dirty-buffer model). There is exactly **one save path**: the `w` verb.

Row lifecycle:

```
clean ──i/Enter/dbl-click──▶ editing ──Esc──▶ dirty ──w──▶ clean (saved)
                                │             │
                                │             └──u──▶ clean (reverted to saved values)
                                │
                                └── Esc on an untouched new row ──▶ row vanishes
                                    ("nothing from nothing")
```

- **Read-first.** Rows render as text. No always-open inputs on master data.
- **Edit mode (INSERT):** the row becomes inputs. Typing modifies the in-memory buffer only — no server write until `w`.
- **Enter never saves.** In edit mode Enter advances to the next field (sticky at the last), same as Tab / Shift+Tab (sticky at both ends).
- **`w` = write** (vim `:w`, colon stripped — the P1-10 `:` palette will alias it for free). Bound in read mode on dirty rows. The only save.
- **`u` = revert** (vim undo): dirty row returns to last-saved values.
- **`s` is not a verb.** Enter is not a verb. One way, clearer.
- **Empty-new-row Esc discards** — never creates something from nothing.

## 2. Mode scoping

Single-key verbs (`j k h l { } i o x w u`) exist **only in read mode**. In edit mode they are characters typed into inputs.

Edit mode recognizes exactly: **Enter, Tab, Shift+Tab, Esc** (+ ArrowUp/Down inside dropdowns).

Enforcement is two-layered:

1. **Focus guard** (existing, `common.js`/`fb-core.js`): single-key verbs are swallowed when a text input/textarea/select/contentEditable has focus.
2. **Edit-active flag** (new, this spec): while a row edit is open, the page sets `window.fbEditActive = true`; `common.js`'s global handler treats `h/l/{/}` (and row-nav `j/k`) as **inert regardless of focus** — closes the checkbox/select-focus hole (e.g. focus on Periods' Locked checkbox mid-edit). ~3 lines, generic, protects every future grid page.

## 3. Verb table (pilot: Periods tab)

| Mode | Key | Action |
|---|---|---|
| read | `j`/`k` | navigate rows, sticky ends (`FB.nav`) |
| read | `i` / Enter / double-click | enter edit mode, first field focused |
| read | add row (bottom) | `+ Add entry` — click, or `j` past the last row / `G`, then `i`/Enter/click to create (fb-list-ux-spec §2; `o` retired 2026-07-23) |
| read | `x` | delete row — confirm; server refuses when referenced (§5) |
| read, dirty row | **`w` / `✓` chip** | **write — the only save** |
| read, dirty row | `u` / `✕` chip | revert to saved values |
| edit | Enter / Tab / Shift+Tab | next / prev field, sticky ends — never saves |
| edit | Esc / `✕` chip | exit to read mode, buffer stays dirty |
| any | `h`/`l` | prev/next tab (free via `common.js`) |
| any | `{`/`}` | prev/next sidebar page (free via `common.js`) |
| read | `?` | which-key overlay (free via `FB.keys`) |

Mouse parity: click row = focus row; click cell = straight into edit mode on that field; `✓` chip = `w`; `✕` chip = Esc in edit mode, `u` on a dirty row. Chips appear in the row's action cell whenever the row is editing or dirty.

## 4. Dirty indication + leave warning

- **Dirty row:** amber left border + dirty values rendered amber in read mode.
- **Tab dot:** the Periods tab label gets a `●` while any row on it is editing or dirty.
- **Leave warning:** switching tab (`h/l`/click), switching page (`{/}`/sidebar click), or browser back/close (`beforeunload`) while any row is editing or dirty opens a modal: **Save / Discard / Stay** (styled, app-idiom; native `confirm()` only as fallback). Save = write all dirty rows, then proceed; Discard = revert all, then proceed; Stay = abort navigation.
- **Veto hooks (new, generic):** (a) in-page tab switches are guarded in the page's own tab-switch function (`showTab`), where the target tab is known — dirty state routes to the modal instead of switching; (b) `common.js`'s `{/}` `fbNavigate` path first calls `window.fbBeforeTabSwitch(href)` when defined — `false` aborts, and the page's modal continuation re-invokes `fbNavigate(href)`; (c) sidebar link clicks get the same treatment via a capture-phase click handler the page registers (mouse parity for `{/}`).

## 5. API: period.delete referenced-check (data-integrity fix)

`period.delete` currently deletes blindly. Periods relate to journal entries by **date-range containment** (`validation.js`: an entry date must fall inside a defined period; locked periods reject posting). Deleting a period that contains entries orphans the period-lock structure.

New guard in `period.delete`: count `journal_entries WHERE company_id = @companyId AND date BETWEEN period.start_date AND period.end_date`; if > 0, refuse with `INVALID_STATE`: `Cannot delete period "<name>": N journal entries fall within its date range.`

## 6. Pilot mechanics (Periods tab)

- Fields: Period Name (text), Start Date (date), End Date (date), Locked (checkbox). Natural key = `period_name` (period.list returns it as `period_id`).
- Validation on `w`: name/start/end required (red `.req` border + message, row stays editing-or-dirty); start ≤ end. Server errors keep the row dirty with inputs' values intact.
- Server round-trip: existing `period.upsert` / `period.delete` / `period.list` actions; no new endpoints beyond the §5 guard.
- Binding set: `FB.keys.register('settings-periods', { active, getMode, bindings })` — `active()` = Periods tab visible. Sidebar hints: `FB.keys.renderHints('settings-periods', #sb-hints, {layout:'list'})`, re-rendered on tab switch alongside the existing `showTab`. `?` overlay resolves automatically from the active set.
- Mode store: shared `FB.mode` (`'NORMAL'`/`'INSERT'`), so `fb-core.js`'s editable-target guard and hint grouping behave exactly as on Payables.
- Row cursor: `FB.nav.create({ rows, focusClass: 'nav-row-focus' })` — sticky ends, scroll-into-view.
- The legacy always-editable Periods grid (`addPeriodRow`/`savePeriodRow`/`deletePeriodRow`/`appendBlankPeriodRow`, per-row 💾/✕ buttons, `confirm()`) is fully replaced — no parallel interaction models on one tab.
- Other five tabs are untouched in the pilot: legacy editable grids, mouse-driven. `h/l`/`{/}` work there as today (common.js global handler; their markup is already `.tabs .tab`).

## 7. Out of pilot scope (agreed in the same thread)

**Status 2026-07-23: the settings panel-consistency decisions below (items 2–5) agreed with Magnus.**

1. **Tab content restructure** (lands with each tab's own migration):
   - **Company tab** → slim **current-company** record only; the all-companies grid moves to `admin.js` (stays as spec'd). The slimmed current-company record **gains the FX provider config** — provider `<select>` + API key, behind an explicit **Save** button (auto-save-on-select is abolished; one-save-path doctrine).
   - **Default Accounts** panel → becomes a **Default flag column** in the COA tab (—/AP/Expense dropdown in edit mode; single-holder enforced server-side in the same write). **Single-holder enforcement clears the previous holder server-side in the same write; the UI must visibly refresh the cleared row so the change doesn't read as a no-op.**
   - **VAT Tolerance** panel → moves into the Tax Codes tab (read-first panel, same read/edit/write grammar).
2. **Tax Codes tab — delete the stale hint.** The bottom hint *"Saving replaces all codes. Existing journal entry tax tags on transactions are preserved."* is stale from the retired bulk-save era. Actual save is per-row `vat.codes.upsert` — identical doctrine to all registers. The now-dead `vat.codes.save` server action (`api/src/vat.js`, DELETE+reinsert) is removed so the API surface matches supported behavior. *(Spec entry only — code removal happens with implementation.)*
3. **Journals tab — hint to the sidebar.** The in-body hint (*"Journal codes appear in the reference sequence (e.g. MISC/2026/0001). Codes should be short uppercase strings."*) moves into the sidebar via the FB.list `hint:` config (fb-list-ux-spec §8) — the only sanctioned location for register notes. Text preserved: journal code = reference prefix, short uppercase, read-only once saved.
4. **COA tab — delete `#coa-search` when framework filters land.** The framework column filters (fb-list-ux-spec §8) supersede per-screen search boxes; Code and Name columns get `filterType: 'text'`.
5. **Exchange Rates tab — panel moves, Fetch Rates stays.** The FX provider `<select>` + API-key row move to the Company tab (item 1) with an explicit Save button; auto-save-on-select is abolished (one-save-path doctrine). **Fetch Rates stays on the Exchange Rates tab** as a list-level action (fb-list-ux-spec §8): `f` verb + one small header button (mouse parity); it imports new rows and must not edit existing ones. **2026-07-23 (rev. 2):** the register is **fully editable like every other list** — no read-only ECB rows, no dimming, delete allowed. A user write **flips the row's source to `manual`**: the client sends the original saved key and the server replaces that row (no ecb+manual duplicates). The legacy bulk **Save Rates button is removed** (one save path: `w`).
6. **Payables doctrine alignment** ✅ **DONE 2026-07-23**: Bills `_insertEscape` no longer saves on Esc (Option A — Esc exits INSERT only, non-empty draft stays as a `fb-draft-dirty` buffer, `w` persists); Vendors migrated onto FB.list (Esc exits, `w`/`u` doctrine + shared leave-guard). Both now follow "Esc never saves". See fb-list-ux-spec §10.
7. Remaining Settings tabs migration order after pilot: COA (highest stakes) → Journals → Tax Codes → Exchange Rates → Company (slim). **Status 2026-07-23: COA, Journals, Tax Codes, Exchange Rates all DONE on FB.list; Company tab slim-down (item 1) + the panel-consistency fixes (items 2–5) remain.**

## 8. What this does NOT change

- `h/l`/`{/}`/`?`/`j/k` shared chrome — reused as-is (plus the two generic hooks in §2/§4).
- Bills' DB-persisted drafts (bill-level INSERT): multi-line documents keep their persistence model. Settings master rows are memory-only — redo cost is seconds and the leave-warning covers navigation accidents. Two persistence models, one verb grammar.
