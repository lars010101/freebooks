# Global Search (`/`) — Spec

**Status:** Built. `:` command mode is fully retired, including its last two
holdouts (`:vat-tolerance`/`:gst-tolerance`) — the §0 cutover gate below is
resolved (2026-09-01).
**Scope:** Retires the `:` command palette entirely. `/` becomes the single summonable input — search, navigation, and (where a page-level verb already exists) the fast path to everything `:` used to reach.
**Supersedes:** `command-bar-ux-spec.md` §2 (trigger keys), §4–§7 (typed `:` grammar, alias table, commit model, parser tiers, bang semantics) — all retired, not refined. Also supersedes `command-bar-ux-spec.md` §4's `/p:`/`/a:`/`/j:`/`/b:` scoped-prefix design and `fb-list-ux-spec.md` §8's "keyboard path" section — this spec is now the canonical description of `/`.
**Depends on:** `fb-core.js` (`FB.search`, `FB.palette` — palette's command-mode machinery is deleted), `fb-command.js` (`ALIASES` table mostly deleted; `tokenize`/`parseDate`/`parseAmount` retained only if still used elsewhere after the alias table is gone — verify at build time), `fb-list.js` (`applyFilterExpr`, unchanged), `search.js` (backend `partner|account|journal|bill` scopes, unchanged), `report-registry.js` (unchanged), `reports-hub.js` (one small addition, §4.2), `access-tab-api-tokens-spec.md` (companion spec — where `:token` migrates).
**Companion:** `access-tab-api-tokens-spec.md`.

---

## 0. Why — and what happens to every existing `:` alias

Killing `:` was evaluated alias-by-alias against the actual page code (not against what the specs claimed), to separate "already has a full UI equivalent" from "would become genuinely unreachable."

| Alias | Disposition |
|---|---|
| `:post` | Retired — Journal Voucher page (`journal-voucher.js`) is the full form |
| `:bill` | Retired — "New Bill" button → `bill-edit.js` form |
| `:pay` | Retired — "Pay" button / `p` verb on a bill row (`payables-bills.js`) |
| `:void` | Retired — `btn-void` button + `x` verb (`bill-detail.js`) |
| `:match` | Retired outright, confirmed safe — `bank.match` is `role: 'agent'` in `action-catalog.js` (unmodified vs. HEAD), called only from `agent-loop.js`. It was never human-reachable through any surviving UI: `bank.js`/`bank-import.js` are deleted, and `bank-reconcile.js` (what remains) has zero references to `bank.match` or to the alias's `palette: false` focused-line context. Nothing to migrate. |
| `:approve` / `:reject` | Retired — identical to `y`/`x` in Inbox |
| `:rate` | Retired — Exchange Rates tab, FB.list add-row |
| `:lock` / `:unlock` | Retired — Settings → Periods tab, FB.list register |
| `:partner add` | Retired — Settings → Partners tab, FB.list add-row |
| `:light` / `:dark` | Retired — theme toggle button (`fb-theme-btn`, `common.js`) |
| `:show` | Retired outright — no replacement needed (owner's call) |
| `:report <type> [period]` | Retired — replaced by the Statements/Journal search categories, §5 |
| `:token create/revoke` | **Migrated**, not retired — no UI existed anywhere for this; see `access-tab-api-tokens-spec.md`. Worth noting: the existing alias is currently **broken**, not merely unused — `fb-command.js`'s `parseToken` sends `{ name }`, but `tokens.js`'s `auth.token.create` requires `email` and `label` (both, or it throws `INVALID_INPUT`). It has likely never successfully dispatched. The Access-tab register (companion spec) uses the real `label`/`email` contract from the start. |
| `:vat-tolerance` / `:gst-tolerance` | **Resolved (2026-09-01) — cutover gate cleared.** The `settings.js` filter that hid these two keys from Extensions (comment: *"they have no UI surface (§7, command-bar only)"*) turned out to be dead code — `fb-list.js` never reads `cfg.list.filter`, so both keys were already rendering and editable in Settings → Extensions the whole time, just undocumented as such. With that confirmed as a real, working UI surface, both commands and the dead filter were removed in the same change: `fbEchoTolerance`, the two `ALIASES` entries, and their parse functions are gone from `fb-command.js`; the `:`/Ctrl+K command-mode trigger is gone from `common.js`; the command-mode machinery in `FB.palette` is gone from `fb-core.js`. Settings → Extensions is now the sole, correctly-documented UI surface for both settings. |

---

## 1. Trigger

`/` is the only summon key going forward. `:` and its entire command-mode code path in `FB.palette` (`_command`, `enterCommand`, the `ALIASES`-driven parse/commit flow in `fb-command.js`) are deleted, not deprecated.

Pressing `/`: the topbar input expands and is **prepopulated with the literal, editable text `search: `**, cursor placed immediately after it. This differs from today's behavior (`/` activates search mode on an otherwise-empty input) — the scope is now always visible as real text the user can see, edit, or backspace into, never a hidden mode flag.

---

## 2. Empty state — the scope list

While the bar reads exactly `search: ` (nothing typed after it), arrowing down opens a dropdown of explicit, selectable scopes — one row per searchable domain:

```
Filter current page: ⁠           ← only when FB.list.visible() is truthy
Journal search: ⁠                ← entries + ledger views, §4
Accounts search: ⁠
Partners search: ⁠
Bills search: ⁠
Statements search: ⁠            ← §5
```

Selecting a row (click, or `Enter` on the highlighted row) **rewrites the bar's text** to that scope's prefix — e.g. selecting "Journal search: " changes the bar's literal contents to `journal search: `, cursor at the end. The prefix is ordinary text, not a hidden state variable: backspacing into it un-scopes the search exactly like editing any other text, no special key required.

`Filter current page: ` is the explicit-selection equivalent of typing `//` today (kept as a power-user shortcut, §7) — same underlying call (`FB.list.visible().applyFilterExpr(...)`), just reachable without memorizing the double-slash.

### 2.1 Recently viewed

Below the scope list, while still unscoped and untyped: the **3 most recently opened objects** — actual records (a specific bill, journal entry, partner, account), never pages, tabs, or reports.

This is new, lightweight, client-only state — no server endpoint. Proposal: `localStorage`, keyed per company, an array of `{type, id, label, route}` capped at 3, most-recent-first, unshifted on every detail-view open. Candidate write points: `bill-detail.js`, `journal-voucher.js` (view-existing-batch path), and any partner/account detail view. Exact write-point list is a build-time task, not a design decision (§8).

### 2.2 Period quick-picks

Also below the scope list:

```
Period: <current default period label>
Period: <period immediately prior>
Period: Custom…
```

Wires to `FB.period`'s existing state (`FB.period.get()`, confirmed in `fb-core.js`) and its existing custom-period picker (`#tb-period-select` + the custom start/end date inputs already built for the topbar period control). No new period-selection widget — this is a keyboard-reachable shortcut into the one that already exists.

---

## 3. Typed state — fuzzy, categorized results

Once text follows a scope prefix (or follows bare `search: ` unscoped, searching everything), the dropdown becomes live results grouped by category, in a fixed order: **Statements → Journal → Accounts → Partners → Bills**.

Each category header renders one of two ways:

- **`<Label>: N items`** when the category has more than one hit.
- **`<Label>: <the item's own label>`** when the category has exactly one hit — the redundant "1 item" collapses into the result itself, and that row *is* the navigable target (no expand step, because there's nothing to expand into).

Example, typing `pro`:

```
Statements: Profit & Loss
Bills: 3 items
Partners: Proffice AB
```

---

## 4. The Journal category — entries, ledger views, and the account-number case

**Journal entries and ledger *views* of those entries are one category, not two.** General Ledger, Trial Balance, Voucher Register, and Line items are not financial reports in the sense P&L/Balance Sheet are — they're the *same* underlying journal-entry data, just pre-filtered or pre-summed. `report-registry.js` already encodes this distinction itself (`category: 'audit'` vs `category: 'financial'`); this spec follows that boundary rather than the registry's incidental file-organization (all of them living in one `REPORT_REGISTRY` array because they share a rendering mechanism).

So "Journal" search results can include, side by side under one header:

- Individual journal entries matched by `reference` (existing `/j:`-equivalent backend scope, unchanged) → opens `journal-voucher.js` in view mode for that `batch_id`.
- Static report-label matches (typing "ledger", "trial", "general") → opens the corresponding report route (`/journal?t=gl`, `/journal?t=tb`, etc.), sourced entirely from the in-memory `REPORT_REGISTRY` (§5), never a network call.
- **Synthesized General Ledger links from account matches** — see below.

### 4.1 Why an account number needs a Journal-category result too

A query like `1023` is genuinely ambiguous: it could be a journal entry reference, or an account code. Both interpretations are useful, and the app already resolves the account interpretation today — `search.js`'s `_searchAccounts()` matches `1023` against **both** `account_name` and `account_code` via `ILIKE`. That hit already surfaces under "Accounts" (routing to the Chart of Accounts row, unchanged). This spec adds a second, synthesized item derived from the *same* account hit, placed under **Journal**:

```
label: 'General Ledger — ' + <account_code> + ' ' + <account_name>
route: '/journal?t=gl&account=' + <account_code>
```

This is a pure **client-side synthesis step** — for every item where `type === 'account'` in the search response, also inject the row above into the Journal group. No backend change to `search.js`.

### 4.2 The `account` param — already wired, end to end, nothing new to build

This is fully shipped already, confirmed by reading the actual code rather than assuming: `reports-hub.js` already reads `account` from `urlParams` (`var drillAccount = urlParams.get('account') || ''`) and threads it into the report-fetch URL it builds. On the server, `render.js`'s `buildGL(query, company, start, end, account)` already filters server-side (`if (account) rows = rows.filter(r => r.account_code === account)`) before the rows ever reach the client. So `/journal?t=gl&account=1023` already produces a General Ledger view scoped to just that account today, for the drill-through links every statement/TB report already emits — no report-side change of any kind is needed for §4.1's synthesized link to work.

One clarification worth recording since it's easy to conflate: GL's `FB.list` **does** have a real, independent `filterType: 'text'` column on `account_code` (`reports/render.js`, `glList`) — but that's a separate, ad-hoc, post-load filter a user can apply by hand after the page renders. It is not what makes the `?account=` drill-through work; that happens server-side, before `FB.list` ever sees the data. No `applyFilterExpr` call is involved in the flow this spec relies on.

The only actual new work in §4 is client-side: the synthesis step in §4.1 (turn an account search hit into a second, additional item under the Journal category with this route). Nothing downstream of that link needs to change.

Integrity is excluded from this synthesis — it's a bespoke `Accounting → Integrity` tab (`/accounting?tab=integrity`), not a filterable report, so it can still fuzzy-match its label for plain navigation but never participates in the account-link synthesis.

---

## 5. Statements — a genuine "reports" category, and why it's instant

Only `pl`, `bs`, `cf`, `sce` belong here — the four entries `report-registry.js` marks `category: 'financial'`. Unlike Journal's DB-backed pieces, this category is a **fixed, ~4-entry, in-memory list** — it fuzzy-matches against report labels **synchronously on every keystroke, client-side, with zero network round-trip**. It renders immediately; Partners/Accounts/Journal-entries/Bills populate a moment later once the debounced `/api/:company/search` call resolves and append into their groups. The two arrival times are independent and expected — no synchronization needed between them.

---

## 6. Multi-level `Enter` / expand

`Enter` drills one level at a time, open-ended (not capped at two presses):

1. Highlighted scope row (empty state, §2) → `Enter` commits that scope's prefix into the bar as real text.
2. Highlighted multi-item category header (typed state, §3) → `Enter` expands it in place; the highlight auto-advances to the category's first child row. A second `Enter` (same key) commits whatever is currently highlighted and navigates, closing the dropdown. Arrow keys between the two `Enter` presses can move the highlight to a different child before committing.
3. A single-item category row has nothing to expand — `Enter` on it commits and navigates immediately, same as step 2's second press, just without a step in between.

This is not a new interaction pattern: it's the same escalating-behavior-on-one-key idea already used by Bills' tree rows (`i`/`Enter` on a folded bill simultaneously opens the fold *and* enters edit mode, per `fb-list-ux-spec.md` §6.1).

---

## 7. `//` and letter-prefixes retained as fast paths

Typing `//` directly (skipping the scope-list detour) remains a synonym for selecting "Filter current page" — same `FB.list.visible().applyFilterExpr()` call, same qualifier grammar (`field:value`, operators) already shipped per `fb-list-ux-spec.md` §8. Nothing about that mechanism changes; this spec only adds a discoverable, arrow-key-reachable route to the same behavior for anyone who hasn't memorized the double-slash.

Likewise, the existing single-letter prefixes (`/p:acme`, `/a:cash`, `/j:1023`, `/b:`) survive unchanged as power-user shortcuts that land directly in the equivalent scoped state, skipping the dropdown-selection step — `parseSearchScope`/`SEARCH_SCOPES` (`fb-command.js`) are reused as-is, not reimplemented. `SEARCH_SCOPES.j` now resolves into the merged Journal category (§4) rather than "entries only," matching what selecting "Journal search: " from the dropdown produces.

---

## 8. Explicitly open

- ~~**VAT/GST tolerance UI surface** — blocks this spec's cutover (§0).~~ **Resolved 2026-09-01** — see §0's updated row. `:vat-tolerance`/`:gst-tolerance` are removed.
- **Recently-viewed write points** — exact list of detail-view pages to instrument (§2.1) is a build-time task.
- **`fb-command.js` cleanup scope, resolved to this extent:** `parseSearchScope` and `SEARCH_SCOPES` survive — `fb-core.js`'s `FB.search` already calls `FB.command.parseSearchScope` directly, and §7 above extends that same reuse. `fbEchoTolerance` did NOT survive — it was deleted 2026-09-01 alongside the two aliases it existed to serve. `ALIASES` is now `{}`; `tokenize`/`parse`/`grammarFor` are kept as general infrastructure (the Tier-0 raw-catalog-action escape hatch, unknown-command handling) even though nothing currently populates `ALIASES`. `fb-command.js` survives as a smaller utility file, as anticipated.

## 9. Changelog

| Date | Change |
|------|--------|
| 2026-09-01 | Cutover gate (§0, §8) resolved: `:vat-tolerance`/`:gst-tolerance` removed along with the dead `settings.js` filter that had been silently failing to hide them from Extensions. `fbEchoTolerance` deleted. `:`/Ctrl+K command-mode trigger removed from `common.js`; command-mode machinery removed from `FB.palette` in `fb-core.js`, keeping only `newTargets()`/`preloadCatalog()` (the `+` New menu, unrelated to `:`). Status updated PROPOSED → Built. |
