# Keyboard UX Spec — navigation, go-to map, palette, switcher, toggle verb

**Status:** ratified 2026-07-28 (Slack design thread, magnus) · **Phase:** K1 shipped
**Consumers:** `api/src/nav-registry.js`, `api/public/fb-core.js`, `api/public/common.js`, `api/public/fb-list.js`, `api/src/pages/common.js`

---

## 1. Route registry — the single source of truth

Every app route lives ONCE in `api/src/nav-registry.js`. Four consumers share
the table so navigation can never drift:

1. **Sidebar** — `navBar()` (`api/src/pages/common.js`) renders `.sb-nav`
   anchors from entries with `sidebar: true`. Sidebar DOM is byte-equivalent
   to the pre-registry markup (same anchors, hrefs, order, active-state).
2. **`{`/`}` cycling** — `common.js` reads the rendered `.sb-nav` anchors.
3. **g-prefix go-to map** — `fb-core.js` reads `window.FB_ROUTES` (injected
   by `navBar` into every page) and maps `gKey` letters → routes.
4. **Command palette** — entries with `palette: true` surface as
   `Go to {label}` rows (scope `nav`).

Entry shape: `{ key, route, label, icon, sidebar, gKey, palette, absolute }`.
`route` uses the `:company` placeholder; `absolute: true` for company-less
routes (`/setup/new-company`). Adding a route = appending one entry — it
becomes keyboard-reachable immediately (§2/§4). Rules live in the registry
file's header comment.

## 2. g-prefix go-to map

Ratified slate:

| Sequence | Action |
|---|---|
| `g r` | Reports |
| `g b` | Bank |
| `g p` | Payables |
| `g s` | Settings |
| `g c` | Company switcher (reserved — not a route) |
| `g g` | Scroll `#page-main` to top + list cursor to first row |
| `g <other>` | Cancel — the key proceeds through normal dispatch untouched |

`g j` (Journal) deliberately omitted: no journal LIST page exists (only
`/journal/new`, a data-entry form). Revisit when a journal register ships.

**Dispatch semantics** (fb-core `_dispatch`, capture phase):

- One pending-`g` state (500 ms window) lives in fb-core. The legacy copies
  in `common.js` and `fb-list.js` are **deleted** — unification was the point.
- Arming: bare `g` in NORMAL mode, never in editable targets
  (`_isEditableTarget`), never with Ctrl/Alt/Meta, and **only when no active
  page set claims `g`** (`_setClaims` — context-override doctrine: page
  bindings beat the global prefix).
- Second key resolves via `_gResolve`: `g` → gg, `c` → switcher, a registry
  `gKey` → navigate (`fbNavigate`, so the dirty-buffer leave-veto applies;
  `window.location` for absolute routes). Anything else cancels and falls
  through to normal dispatch.
- `G` (scroll bottom + last row) is unchanged — fb-list binding on list
  pages, `common.js` bubble fallback elsewhere.
- **gg unification hook:** fb-core scrolls to top, then fires every
  `FB.nav.onGG(fn)` hook. Each FB.list instance registers a hook that calls
  `nav.first()` **only when its panel is visible** (`offsetParent` guard —
  settings mounts six instances; hidden tabs must no-op).

## 3. Company switcher keyboard contract

`g c` toggles `#tb-company-dropdown`. It reuses `fbToggleCompany`'s data path
(`common.js`, extended with an `onReady(opened)` callback) — no duplicated
fetch/render. While open, the switcher owns EVERY key (help-overlay
precedent — page bindings and `common.js` stay inert):

| Key | Action |
|---|---|
| `j` / `↓` | Highlight next option (sticky at bottom) |
| `k` / `↑` | Highlight previous option (sticky at top) |
| `Enter` | Follow the highlighted anchor — plain `.click()`, exactly the mouse path |
| `Esc` | Close |
| `g c` | Toggle closed (mirror of the open sequence) |

Keyboard highlight uses `.tb-company-focus` (mirrors `:hover` styling).
Mouse behavior (click header to open, outside-click to close) is unchanged.

## 4. Palette navigation source

Third palette source alongside page verbs and the API catalog: registry
routes with `palette: true` render as `Go to {label}` rows showing the `g`
key-equivalent (the palette doubles as a keyboard teacher). Fuzzy + recency
ranking identical to existing rows.

**Dedupe rule:** the registry carries the decision. Routes already covered by
an action-catalog `navigate` entry (`/journal/new`, `/bank/import`,
`/setup/new-company`) keep `palette: false` — their catalog action labels
describe the destination well enough. Sidebar routes and `/opening-balances`
carry `palette: true`. (A runtime route-match dedupe was tried and rejected:
catalog navigate targets like `/payables` for `vendor.save` are action
labels, not go-to rows — matching on them swallowed the real `Go to` rows.)

## 5. `~` — the universal toggle verb

Ratified: `~` is THE toggle verb framework-wide (precedents: Vendors
`~` toggle-active, `payables-vendors.js`; vim's own toggle-case key).

- **Bank transaction panel: `c` → `~` migrated 2026-07-28** (clear/unclear).
  `c` is released; on FB.list filter surfaces `c` remains 'clear filters'
  (different semantic, unchanged).
- Future toggle semantics (reconcile clear/unclear, journal-new reversal
  mode, reports comparison toggles) bind `~` — no per-screen invention.

## 6. Opening Balances placement

The opening-balances screen (`/:company/opening-balances`) is the
once-per-company migration tool (enter the opening trial balance as of the
go-live date; posts one balancing journal batch). Precedent: **Xero keeps
"Conversion Balances" under Settings**; QBO enters opening balances per
account. Ratified: linked from **Settings → Company** (setup box above the
danger zone), NOT the sidebar; palette-reachable via §4. It carries no `g`
letter (run-once screen — letters are for high-frequency routes).

## 7. Deferred (later phases)

- **K2** — FB.keys binding stack (push/pop scope) + shared `FB.modal`
  keyboard contract: Esc = cancel (never confirms), `y`/`n` confirms,
  type-to-confirm for destructive actions (GitHub repo-deletion pattern);
  retrofit the FB.list leave-guard and the danger-zone modal.
- **K3** — `FB.form`: the bill-edit modal model (NORMAL rest state +
  Tab/Shift+Tab inside edits) as a shared form machine; pilot journal-new
  (`j`/`k` rows, `h`/`l` cells, `Enter`/`i` edit, `a` add line, `x` delete
  line, `~` reversal toggle, `w` post, `q` quit), then reports filter bar,
  bank-import mapping, opening-balances, new-company.
- **K4** — Attachment keyboard unification (`A` = attach everywhere;
  attachment queue as FB.list so `j`/`k`/`x` come free); reconcile/import
  rows onto FB.list.
- **K5** — CI keyboard-coverage crawl (every route asserts an active
  FB.keys set + every visible control reachable).
- `?` overlay GLOBAL section (chrome keys: g-map, `{`/`}`, `h`/`l`, `/`,
  `:`) — the overlay currently documents the active page set only.
- Vimium-style `f` hint overlay as a universal mouse-parity fallback —
  likely unnecessary once K1–K4 land; revisit after K5 measurement.
