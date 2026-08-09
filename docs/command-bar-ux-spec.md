# Command-Bar UX Spec

**Status:** Draft — design agreed in principle, not yet implemented.
**Supersedes:** the persistent sidebar as primary navigation. `g`-prefix motions and the existing `FB.keys` / `FB.list` / `FB.form` framework are retained unchanged.
**Context:** single-user (self-hosted, one operator) — this spec deliberately skips multi-user discoverability scaffolding (onboarding flows, progressive disclosure for strangers). Optimize for round-trip speed and fast re-learning after time away, not first-contact friendliness.

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

This split mirrors vim exactly and is non-negotiable as a mental model: if it doesn't change data, it's `/`; if it might, it's `:`.

`g`-prefix motions are **not** replaced. They remain the zero-argument, zero-latency jump for the fixed set of top-level pages (dashboard, bank, payables, inbox, reports, settings). `:` and `/` take over everything parametrized or long-tail. Do not let `g` and `:` compete for the same job — `g i` should always be faster than typing a command to get to Inbox.

---

## 3. Persistent chrome

Sidebar is gone. One thin, bottom-anchored status line remains (vim command-line position), showing:

```
<company> · <period> · <n> pending inbox · <mode>
```

This is the only always-visible UI outside of page content. Everything else — navigation, action list, help — is summoned via `/` or `:` and disappears after use.

Empty `:` or `/` with nothing typed shows recent commands + suggestions ranked by the current `FB.keys` scope (e.g. inside Bank reconciliation, `:match`/`:approve` rank above global commands). This is the sidebar's discoverability function, recovered on demand instead of parked on screen.

---

## 4. Command grammar

```
:<verb> <args...> [keyword slots] [--flags] [!]
```

- Whitespace-tokenized; quotes for multi-word entities: `:bill "Nordic Freight AB" 1200`
- Keyword slots (`from`, `to`, `due`, `on`, `vat`, `net`) are fixed parse anchors — deterministic, no LLM needed for the common path.
- Trailing `!` is the explicit "skip the confirmation form, commit directly" escape hatch. See §7.

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
| `:pay` | Bill settlement (via prefilled form) | `:pay acme 1200 from checking` |
| `:pay!` | Bill settlement (direct commit) | `:pay! acme 1200 from checking` |
| `:void` | `bill.void` | `:void AP/2026/00003` |
| `:match` | `bank.match` (focused line) | `:match` |
| `:approve` / `:reject` | Same as `y` / `x` in Inbox | `:approve` |
| `:report` | Opens report by type + period | `:report pl q2` · `:report gl ytd` |
| `:rate` | `fx.rates.save` / `fx.fetch_rates` | `:rate eur 1.09` |
| `:lock` / `:unlock` | `period.save` | `:lock aug` |
| `:vendor` | `vendor.save` | `:vendor add "Acme Corp" net30` |
| `:token` | `auth.token.create` / `auth.token.revoke` | `:token create agent-hermes` |

### Argument parsing

- **Amounts:** bare number = home currency; `500 eur` for explicit currency. For `:bill`, the bare number is the **gross/invoice-stated** amount — what's printed on the paper bill — not net.
- **Dates:** `today`, `sep15`, `2026-09-15`, `+30d`. Small chrono-style parser, not full NL.
- **Accounts / vendors:** fuzzy-matched against the existing COA and vendor-master autocomplete data (already built for journal entry — no new data source). Ambiguous matches surface as inline ghost-text with arrow-key cycling through top candidates.
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

`/p:` is deliberately **direction-agnostic** — it doesn't distinguish vendor from customer, matching the unified `partners` table (`is_vendor`/`is_customer` flags on one entity, not two). Search only needs to find "Acme"; direction is expressed at the command level (`:bill` vs `:invoice`), not the search level. This mirrors the actual schema, which merged the former `vendors` table into `partners` for exactly this reason.

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
| `:pay` | Bill settlement | Opens prefilled settlement form | Commits directly |
| `:void`, `:lock`, `:token revoke` | respective actions | Single `y` confirm (existing Inbox idiom, not a full form) | N/A — these are already a single confirm, not a form |

`:bill` is a deliberate exception to "form by default," but for a more precise reason than originally assumed. `bill.create` itself is **not** universally safe — read directly from `api/src/bills.js`: it branches on `ctx.actor.actorType`, and only an `agent` caller gets redirected to a draft (`saveDraftBill`). A **human** caller hitting `bill.create` validates, computes VAT, writes journal entries, and posts immediately and synchronously — VAT-tolerance mismatches are returned as non-blocking `warnings`, not something that stops the post.

That means the command bar cannot alias `:bill` to `bill.create` and get draft-safety "for free" the way the earlier draft of this spec assumed — the human path posts directly. Instead, `:bill` (no bang) is aliased to **`bill.draft.save`** explicitly: zero ledger impact, computes the VAT split for display, writes a `status='draft'` row. The real commit/finalize step is `bill.draft.post` (which internally delegates back into `createBill`, and is where the VAT-tolerance check actually runs) — see §9 for how that surfaces in the Inbox.

---

## 6. Parser tiers

| Tier | Method | Used for |
|---|---|---|
| 0 | Exact catalog match | `:journal.propose ...` typed literally — the raw escape hatch |
| 1 | Structured/deterministic | Keyword-slot parsing (`from`, `due`, `vat`, ...) against amounts, dates, fuzzy-matched accounts/vendors |
| 2 | LLM-assisted (existing AI-endpoint setting, same one used for tier-4 bank matching) | Genuinely ambiguous natural-language input |

Tier 0/1 parses land in a prefilled form (§5) or, with `!`, commit directly.
**Tier 2 parses never take `!` and never commit directly** — they route through `journal.propose` into the existing Inbox review queue, same as agent output. The reasoning: `!` expresses confidence in the operator's own input, not permission to skip catching a parser mistake the operator doesn't know exists yet. An LLM-inferred command reviewed asynchronously in the Inbox gets exactly the same trust treatment as an autonomous agent's proposal — same boundary, same UI, regardless of which "actor" produced it.

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
- **Account/vendor resolution** reuses existing autocomplete data sources.
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
