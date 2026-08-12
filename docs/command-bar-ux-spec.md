# Command-Bar UX Spec

**Status:** Draft — design agreed in principle, not yet implemented.
**Supersedes:** the persistent sidebar as primary navigation. `g`-prefix motions and the existing `FB.keys` / `FB.list` / `FB.form` framework are retained unchanged.
**Context:** single-user (self-hosted, one operator) — this spec deliberately skips multi-user discoverability scaffolding (onboarding flows, progressive disclosure for strangers). Optimize for round-trip speed and fast re-learning after time away, not first-contact friendliness.

---

## 0. Relationship to the existing `:` command palette (P1-10)

**This section matters — read before the rest.** A `:`-triggered command palette already exists and ships (`FB.palette`, `fb-core.js`, spec: `docs/payables-ux-spec.md` §P1-10, built 2026-07-23, commit `d1c2110`). It is **not** what the rest of this document describes. Its actual shape:

- One topbar input, two modes (`/` = search, `:` = command), toggled by *how* you entered it (keyboard vs. click), not by content.
- Commands are **derived, not parsed** — two sources (#149): page verbs (current `FB.keys` scope's hinted bindings, filtered: movement/chrome opt out via `paletteEligible: false`; business verbs covered by a `:` alias are deduped), and API actions (catalog entries carrying a `palette: execute | navigate` disposition). NAV rows (registry routes) were dropped from `:` and relocated to the `?` help overlay.
- `execute` actions fire immediately with **no parameters beyond `companyId`** (e.g. `fx.fetch_rates`).
- `navigate` actions route to the owning form/page — e.g. `bill.create` and `bill.draft.save` both currently route to the same blank `/bill/edit`, with nothing pre-filled.
- Matching is fuzzy-subsequence over the item's label, ranked by localStorage recency then match quality. There is **no argument grammar, no keyword slots, no inline parsing of trailing text.**
- This is a stated, deliberate design decision, not an oversight — quoting the spec directly: *"A command can't collect a bill's lines in a dropdown; routing to the form is the honest execution."*

**What this means for §4–§7 below:** the typed grammar this spec proposes (`:bill acme 1200 due sep15`, keyword slots, Tier 0/1/2 parsing, bang-to-skip-the-form) is a **genuine extension beyond P1-10**, not a refinement of it. It knowingly overrides the "route to form, don't parse a dropdown" philosophy P1-10 recorded for a reason that's still valid in general — a one-line input truly can't collect a multi-line bill. The case for overriding it anyway, for a narrow set of high-frequency commands, rests entirely on this being a single-user tool optimized for round-trip speed (§ header) rather than general-audience polish; that trade only makes sense here because of that context, and should be read as a conscious deviation, not a gap P1-10 missed.

**What still stands unchanged:** `/` search, page verbs (filtered: movement/chrome excluded, alias-covered deduped — #149), the `execute`/`navigate` disposition model for everything *not* explicitly upgraded to typed grammar in §4's alias table, and the underlying palette UI chrome (dropdown, fuzzy match, recency ranking) — this spec's empty-`:`/`/ ` suggestion behavior (§3) is describing the same mechanism P1-10 already built, not a new one.

---

## 1. Goal

Replace the persistent sidebar with two summonable input modes, bound to `/` and `:`, consistent with the vim semantics the app already trains (`g i`, `y`/`x` in Inbox). The win is **not** reclaimed pixels — it's reduced chrome, less cognitive load, and one consistent interaction model instead of two (point-and-click nav plus keyboard shortcuts layered on top).

Cutover is **hard**, not phased: sidebar removed in the same change that ships the command bar. No dual-run period.

---

## 2. Trigger keys

| Key | Mode | Mutates? |
|---|---|---|
| `/` | **Find** — search/filter/navigate to something that exists | Never |
| `:` | **Command** — do something (create, post, approve, match, report) | Sometimes |

This split mirrors vim exactly and is non-negotiable as a mental model: if it doesn't change data, it's `/`; if it might, it's `:`. Matches the existing `FB.palette` implementation directly — one topbar input, mode set by *how* it's entered (keyboard `/` or `:` vs. mouse click always defaults to search), not by parsing content (§0).

`g`-prefix motions are **not** replaced. They remain the zero-argument, zero-latency jump for the fixed set of top-level pages (dashboard, bank, payables, inbox, reports, settings). `:` and `/` take over everything parametrized or long-tail. Do not let `g` and `:` compete for the same job — `g i` should always be faster than typing a command to get to Inbox.

---

## 3. Persistent chrome

Sidebar is gone. One thin, bottom-anchored status line remains (vim command-line position), showing:

```
<company> · <period> · <n> pending inbox · <mode>
```

`<mode>` is not new: `common.js` already renders a NORMAL/INSERT indicator (`#fb-vim-mode`, driven by `FB.mode.onChange`) somewhere in the current chrome. This is a relocation, not new logic — the status line just needs to host the existing element rather than build a second one.

This is the only always-visible UI outside of page content. Everything else — navigation, action list, help — is summoned via `/` or `:` and disappears after use.

**Dead bindings once the sidebar goes:** `common.js` currently documents `{` / `}` as "sidebar prev/next item (navigate pages)" — a real, working binding tied directly to sidebar presence. Once the sidebar is removed these have nothing left to navigate and should be deleted outright, not left registered as silent no-ops — same standing-rule-6 treatment the project already applies to other dead code (e.g. the P1-6 removal of the old `:` stub, §0).

Empty `:` or `/` with nothing typed shows recent commands + suggestions ranked by the current `FB.keys` scope (e.g. inside Bank reconciliation, `:match`/`:approve` rank above global commands). This is the sidebar's discoverability function, recovered on demand instead of parked on screen — and it's the existing `FB.palette` recency/ranking behavior (§0), not new UI.

---

## 4. Command grammar

```
:<verb> <args...> [keyword slots] [--flags] [!]
```

- Whitespace-tokenized; quotes for multi-word entities: `:bill "Nordic Freight AB" 1200`
- Keyword slots (`from`, `to`, `due`, `on`, `vat`, `net`) are fixed parse anchors — deterministic, no LLM needed for the common path.
- Trailing `!` is the explicit "skip the confirmation form, commit directly" escape hatch. See §7.

**Inline syntax hint while typing.** Once a recognized command word is typed and a pause is detected, render its remaining grammar as a thin hint under the bar — e.g. typing `:bill` shows `<partner> <amount> [due <date>] [vat <amt>|net <amt>|rc]` sourced from the same alias-table metadata that drives `?` (§8). This is specifically new behavior on top of `FB.palette` (§0) — the existing palette has no argument grammar to hint about, since `navigate`-disposition entries take no typed args at all. The goal is to resolve "I remember the command but not its exact argument order" without breaking flow into the `?` overlay: a smaller, cheaper win for round-trip speed than the overlay is, precisely because it never requires leaving the bar.

**Note on "verb":** the top-level command word doesn't need to be a grammatical verb — `:je` isn't one either, and neither are most vim ex-commands (`:w`, `:q`) or git subcommands (`log`, `diff`, `status`). Command-bar tokens are read as **command names**, not conjugated as sentences: `:bill acme 1200` parses as "the Bill command, args: acme, 1200," not as the imperative "I bill Acme" (which would misleadingly point AR). `:bill`/`:invoice` are a matched noun pair — the two document types, matching the module names (`bill.*`, `invoice.*` once built) and the tab labels ("Bills"/"Invoices") already standard across QuickBooks/Xero/Odoo/Zoho. That existing convention is what makes `:bill` land as AP despite the verb-sense ambiguity, not despite the convention — the same industry-wide "Bills = AP" association that creates the theoretical ambiguity is exactly what resolves it in practice for anyone who's used accounting software before. See §6 for the one place this doesn't fully hold — free-form NL parsing, once `:invoice`/AR exists.

### Alias table

Every alias is sugar over a real `<module>.<verb>` action from the existing action catalog (`GET /api/actions`) — **not** a parallel command system. Anything without an alias still works verbatim (`:journal.propose companyId=... lines=...`), so the grammar can never drift out of sync with the API, and newly added catalog actions are usable immediately, before anyone bothers writing a friendly alias.

| Alias | Resolves to | Example |
|---|---|---|
| `:post` | `journal.post` (via prefilled form — see §5) | `:post 500 supplies from cash` |
| `:post!` | `journal.post` (direct commit) | `:post! 500 supplies from cash` |
| `:je` | Blank multi-line journal form | `:je` |
| `:bill` | `bill.draft.save` (AP; see §5) | `:bill acme 1200 due sep15` |
| `:bill` w/ VAT override | `bill.draft.save` | `:bill acme 1200 vat 240` · `:bill acme 1200 net 960` · `:bill acme 1200 rc` |
| `:invoice` *(reserved, AR — not yet wired)* | AR module, tbd | `:invoice acme 1200 due sep15` |
| `:pay` | `bill.payment.record` (via prefilled form — see §5) | `:pay acme 1200 from checking` |
| `:pay!` | `bill.payment.record` (direct commit) | `:pay! acme 1200 from checking` |
| `:void` | `bill.void` | `:void AP/2026/00003` |
| `:match` | `bank.match` (focused line) | `:match` |
| `:approve` / `:reject` | Same as `y` / `x` in Inbox | `:approve` |
| `:report` | Navigates to the Reports hub (`/reports`) — see note below | `:report` |
| `:rate` | `fx.rates.save` / `fx.fetch_rates` | `:rate eur 1.09` |
| `:lock` / `:unlock` | `period.save` | `:lock aug` |
| `:partner` | `partner.upsert` | `:partner add "Acme Corp" net30` |
| `:token` | `auth.token.create` / `auth.token.revoke` | `:token create agent-hermes` |

**`:report` — no catalog change, deliberately.** Reports are served via `GET /api/:company/report?type=&start=&end=` — a plain GET route, never in the action catalog, never in the P1-10 `PALETTE` disposition map (§0). That's consistent with the existing route-command pattern (`window.FB_ROUTES`, `_routeCommands()`) already used for other pure-navigation targets, and it means **no backend change is required** to add `:report` — it's a route command, not an action. It intentionally does *not* parse `pl q2`-style shorthand into a direct report view; doing that would require the same new argument-parsing capability `:bill`/`:post` need (§4–§6), and there's no reason to special-case it just for reports. If inline period/type shorthand is wanted later, treat it as an application of that general grammar layer once built, not a one-off fix — see §10.

**`:pay` and the id-resolution problem P1-10 deliberately avoided.** `bill.payment.record` needs a specific `billId`, and P1-10's own design explicitly excludes actions "needing context the palette cannot supply (ids, lines, amounts)" from the palette for exactly this reason (§0) — deferring them to page verbs in context instead (e.g. a `p` keybinding on a focused bill row). `:pay acme 1200 from checking` requires fuzzy-resolving "acme" down to *one* specific open bill, which is ambiguous the moment a partner has more than one outstanding bill. Worth deciding explicitly whether `:pay` should exist as a typed command at all, or whether bill payment should stay a page-verb-only action consistent with P1-10's existing philosophy — flagged rather than resolved here.

**`:vendor` → renamed `:partner`, retargeted.** The alias in the prior draft resolved to `vendor.save`, which no longer exists as a real action — it only works today through a deprecation shim (`ACTION_ALIASES` in `index.js`, mapping `vendor.save` → `partner.save` with a console warning). If the tracked removal of `vendor.*` aliases lands before this spec is built, `:vendor` breaks outright. Two fixes, both applied: (1) target `partner.upsert`, not `partner.save` — the catalog describes `partner.save` as "Replace partners (bulk)" and `partner.upsert` as "Insert or update **one** partner," and a single `:partner add ...` command has upsert semantics, not bulk-replace; using `partner.save` here would be actively wrong, not just deprecated. (2) rename the alias itself to `:partner`, matching the module name and the `/p:` search scope (§4) rather than keeping a vendor-specific name for an action that also creates customers.

### Argument parsing

- **Amounts:** bare number = home currency; `500 eur` for explicit currency. **`:bill`'s amount semantics — verified against `saveDraftBill`, and this needs explicit documentation because the naive behavior is a real trap.** `saveDraftBill` only computes a gross/net/VAT split when a `lines` array with a `vat_code` is present; if the command sends a bare `bill.amount` with no `lines`, the function takes its no-lines branch, storing that number as pure **net** with `vat_amount: 0`. There is also currently **no default VAT-code source anywhere** — not on `companies`, not on `partners` (checked `schema.sql`; the partner record has no `default_vat_code` column), not a flagged default row in `vat_codes`. So: `:bill acme 1200` (bare number, no VAT info) **must be documented as net**, matching what `saveDraftBill` actually does today with zero backend change — the parser should synthesize `bill.amount = 1200` directly, not attempt a gross-to-net back-calculation it has no default rate to perform. The `vat 240` / `net 960` / `rc` modifier forms are unaffected by this gap — they carry the VAT information explicitly, so the parser can synthesize a proper `lines: [{amount, vat_code}]` array without needing any default. True "type the gross, VAT is derived automatically" behavior for the bare-number case would require adding a default-VAT-code setting first (company-level is the simpler option, partner-level would need a new column) — a real, separate prerequisite, not a parsing detail, and out of scope here unless prioritized on its own.
- **Dates:** `today`, `sep15`, `2026-09-15`, `+30d`. Small chrono-style parser, not full NL.
- **Accounts / partners:** fuzzy-matched against the existing COA and partner-master autocomplete data (already built for journal entry — no new data source). Ambiguous matches surface as inline ghost-text with arrow-key cycling through top candidates.
- Parse errors render inline in the bar itself, shell-style — never a toast, never a mode switch. Stay in the same keystroke flow to fix and resubmit.

### `/` search — scoped prefixes

```
/acme         fuzzy across everything (partners, bills, journals, accounts)
/p:acme       partners only — vendors and customers, unified (partners table)
/a:cash       accounts only
/j:1023       journal reference
/b:           open bills
```

Single-letter scope prefixes chosen for terseness over self-documentation — this is a tool used hundreds of times by one person, not a stranger's first session.

`/<query>` unprefixed always searches the full unscoped index; the letter prefixes narrow the search, they never gate it.

"Everything" means the same curated identity-field index the scoped prefixes draw from (partner name, account name/code, journal reference, bill reference), unioned across entity types — not a raw scan of every table/column. Non-entity tables (`audit_log`, `events`, `api_tokens`, `idempotency_keys`, `settings`) are out of scope for search entirely.

`/p:` is deliberately **direction-agnostic** — it doesn't distinguish vendor from customer, matching the unified `partners` table (`is_vendor`/`is_customer` flags on one entity, not two). Search only needs to find "Acme"; direction is expressed at the command level (`:bill` vs `:invoice`), not the search level. This mirrors the actual schema, which merged the former `vendors` table into `partners` for exactly this reason.

**Journal references** (post-#195): `reference` is a plain `NNNNN` sequential doc number scoped per journal per year (5-digit zero-padded, e.g. `00001`). The old `CODE/YEAR/NNNNN` format has been simplified — the journal code prefix is redundant now that `journal_id` lives on the row. `/j:1023` matches the `reference` field on `journal_entries` and returns the owning `batch_id` as the navigation target.

---

## 5. Commit model: form-prefill vs. direct commit

This is the central design decision and it applies per-verb, not globally.

**Default (no `!`):** any verb that creates new ledger-affecting data parses into a prefilled form (`FB.form`) rather than calling the mutating action directly. The form's own save button performs the actual commit. This means:

- Nothing new needs building for review/confirmation — `validation.js`'s period-lock, balance, and COA checks already run at form-save.
- VAT computation is visibly rendered before anything exists in the DB.
- Parser quality (Tier 0/1 deterministic vs. Tier 2 LLM-assisted, see §6) only affects how good the *prefill* is, never whether bad data can commit. A mediocre parse just means more manual correction inside the same form.

**With `!`:** skip the form, commit directly via the underlying action, subject to the rules in §7.

| Verb | Underlying action | Default behavior | `!` behavior |
|---|---|---|---|
| `:post` | `journal.post` | Opens prefilled journal form | Commits directly |
| `:je` | `journal.post` | Opens blank journal form | — (no bang; nothing to skip) |
| `:bill` | `bill.draft.save` | Creates a **draft** directly (zero ledger impact — see below) | Deferred, not implemented (§7, §10) |
| `:pay` | `bill.payment.record` | Opens prefilled settlement form | Commits directly (id-resolution caveat above still applies) |
| `:void`, `:lock`, `:token revoke` | respective actions | Single `y` confirm (existing Inbox idiom, not a full form) | N/A — these are already a single confirm, not a form |

`:bill` is a deliberate exception to "form by default," but for a more precise reason than originally assumed. `bill.create` itself is **not** universally safe — read directly from `api/src/bills.js`: it branches on `ctx.actor.actorType`, and only an `agent` caller gets redirected to a draft (`saveDraftBill`). A **human** caller hitting `bill.create` validates, computes VAT, writes journal entries, and posts immediately and synchronously — VAT-tolerance mismatches are returned as non-blocking `warnings`, not something that stops the post.

That means the command bar cannot alias `:bill` to `bill.create` and get draft-safety "for free" the way the earlier draft of this spec assumed — the human path posts directly. Instead, `:bill` (no bang) is aliased to **`bill.draft.save`** explicitly: zero ledger impact, computes the VAT split for display, writes a `status='draft'` row. The real commit/finalize step is `bill.draft.post` (which internally delegates back into `createBill`, and is where the VAT-tolerance check actually runs) — see §9 for how that surfaces in the Inbox.

---

## 6. Parser tiers

| Tier | Method | Used for |
|---|---|---|
| 0 | Exact catalog match | `:journal.propose ...` typed literally — the raw escape hatch |
| 1 | Structured/deterministic | Keyword-slot parsing (`from`, `due`, `vat`, ...) against amounts, dates, fuzzy-matched accounts/partners |
| 2 | LLM-assisted (existing `llm_endpoint_url`/`llm_api_key`/`llm_model` company settings — same fields `tier4LLMReason()` reads for bank-matching tier 4, and the same ones the bill-extraction text layer reads in `agent-loop.js`; verified via a dedicated `settings.ai.test` connectivity-check action, so this isn't a hardcoded call site for either feature) | Genuinely ambiguous natural-language input |

Tier 0/1 parses land in a prefilled form (§5) or, with `!`, commit directly.
**Tier 2 parses never take `!` and never commit directly** — they route through `journal.propose` into the existing Inbox review queue, same as agent output. The reasoning: `!` expresses confidence in the operator's own input, not permission to skip catching a parser mistake the operator doesn't know exists yet. An LLM-inferred command reviewed asynchronously in the Inbox gets exactly the same trust treatment as an autonomous agent's proposal — same boundary, same UI, regardless of which "actor" produced it.

**No-LLM-configured fallback:** when Tier 1 fails to parse and the company has no LLM configured (no `llm_endpoint_url`/`llm_api_key` — the same settings Tier 2 checks), the parse error renders inline in the bar itself, shell-style — the same behavior §4 already specifies for parse errors generally. There is no silent no-op and no toast. The operator stays in the same keystroke flow to fix and resubmit.

**Residual risk once `:invoice`/AR exists:** the noun-command reading of `:bill` (§4) resolves the AP/AR ambiguity for literal command names, but doesn't fully carry over to Tier 2 free-form prose. Natural spoken/written English leans AR for the verb sense — "I billed Acme for 500" reads as "I charged them," not "I received a bill from them." Moot today since there's no AR target to misroute to, but the Tier-2 parsing prompt will need explicit disambiguation guidance once `:invoice` is wired — e.g. biasing toward the literal command name and treating loose "bill/billed" prose without one as ambiguous rather than guessing a direction.

---

## 7. Bang (`!`) semantics

1. **Tier 0/1 only.** On a Tier 2 (LLM-parsed) command, `!` is silently ignored and the form/Inbox path is used regardless.
2. **Confidence override, not correctness override.** `!` does not suppress the form when the parse itself is uncertain — ambiguous account match, VAT-tolerance breach, unresolved date. In those cases the form still opens, with a short inline reason (e.g. *"opened — ambiguous match on 'supplies'"*). `!` is riskiest exactly where a garbled command is most likely, so it must not disable the one check that catches that.
3. **Idempotency:** direct-commit paths (`:post!`, `:pay!`) must send the `Idempotency-Key` header already supported by the mutating action endpoints. This is the primary defense against a double-Enter (fat-fingered or a flaky request) silently double-posting — there's no form step in between to catch it visually.
4. **Per-verb stakes differ — `!` is not one policy.** `:post!`/`:pay!` touch the ledger directly, the real no-safety-net case. `:bill!` would map to `bill.create` directly — the human-immediate-post path (§5) — which is a bigger behavior jump than a simple form-skip, since it bypasses the draft stage entirely rather than just skipping a preview of it. Deferred; not implemented in this pass (§10).

---

## 8. Relationship to existing systems (no new infrastructure)

- **Scope-aware ranking** reuses `FB.keys`'s existing scope stack — no new context system.
- **Form rendering** reuses `FB.form` (zones, cursor) — no new confirmation widget.
- **Async review** reuses `journal_proposals` + the Inbox `y`/`x` queue — no new approval mechanism.
- **`:bill` review** reuses the existing `bill_draft` Inbox item type unchanged in structure — `queryBillDrafts()` in `inbox.js` already filters only on `status='draft'`, with no actor-type restriction, so a human-authored draft from `:bill` appears in the same Class A queue as an agent-authored one, with the same `y`/`x` (`bill.draft.post`/`bill.draft.delete`) verbs. Two small, targeted fixes needed, not new infrastructure — see §9.
- **Account/partner resolution** reuses existing autocomplete data sources.
- **Mutation safety** reuses the existing `Idempotency-Key` mechanism.
- **Action surface** is the existing action catalog, filtered by the existing role table — the command bar adds no new permission model.

---

## 9. Resolved: `bill.create` behavior (was open, now confirmed against source)

Read directly from `api/src/bills.js` and `api/src/inbox.js`:

- `bill.create` branches on `ctx.actor.actorType`. Only an `agent` caller is redirected to `saveDraftBill`. A **human** caller posts immediately and synchronously (validates, computes VAT, writes `journal_entries`, sets `status='posted'`). VAT-tolerance mismatches are returned as non-blocking `warnings`, never blocking.
- The actual staged/safe path is `bill.draft.save` (creates `status='draft'`, zero ledger impact) → `bill.draft.post` (the finalize step, which delegates back into `createBill` and is where the VAT-tolerance comparison actually executes).

**Decision:** `:bill` (no bang) is aliased to `bill.draft.save`, not `bill.create`. `:bill!` — which would map to `bill.create` directly — is deferred (§10), consistent with not needing a form-skip for an action that's already cheap and reversible-before-commit.

### VAT-tolerance visibility in the Inbox

`inbox.js`'s `queryBillDrafts()` already produces a `bill_draft` Class A item (verbs `y`/`x`) for any row with `status='draft'`, filtered only by `company_id` — no actor-type check. A draft created by `:bill` will appear in the same queue an agent's draft would, with no inbox.js changes required to get it there at all.

Two concrete, small follow-ups to make the tolerance check visible **before** commit rather than only in the response of pressing `y`:

1. Factor the VAT-tolerance comparison (currently inline inside `createBill`, duplicated conceptually in `saveDraftBill`'s totals computation) into a shared helper, and call it from `queryBillDrafts()` to attach a `warning` string to the inbox item shape. This makes the mismatch visible in the queue itself, not just after acting on it.
2. `queryBillDrafts()` currently hardcodes `source: 'agent'` on every item regardless of `created_by`. Fix this alongside (1) — the row already carries `created_by`, it just isn't wired into the `source` field. Left unfixed, every `:bill`-created draft will be mislabeled as agent-authored in the queue.

---

## 10. Explicitly out of scope for this spec

- Multi-user discoverability (help overlays, onboarding, progressive menu fallback for first-time users) — deferred as unnecessary for a single-operator deployment.
- Phased/dual-run migration — this is a hard cutover.
- Mouse/pointer-driven fallback UI for the removed sidebar.
- `:bill!` (direct `bill.create` commit, bypassing the draft stage) — deferred. Plain `:bill` → `bill.draft.save` covers the default path; revisit the bang variant only if the extra keypress to finalize via the Inbox proves genuinely annoying in practice.
- `:invoice` (AR) — reserved as a name, not wired to anything until AR is un-deferred.
- `:report pl q2`-style inline period/type shorthand — deferred. Plain `:report` → Reports hub navigation ships first (§4); shorthand parsing is an application of the general argument-grammar layer, not a special case, and isn't worth building in isolation.
- Default-VAT-code setting (company- or partner-level) — a real prerequisite for gross-first `:bill` entry (§4), but a separate, standalone change, not part of this spec.
- Resolving whether `:pay` should exist as a typed command at all, given P1-10's explicit exclusion of id-ambiguous actions from the palette (§4) — flagged, not decided.
