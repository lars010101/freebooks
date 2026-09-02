# Bill Post/Payment Consolidation — Spec

**Status:** Draft — design agreed in principle (session with magnus, 2026-09-02), not yet built.
**Scope:** `api/src/pages/bill-edit.js` (full-page bill editor), `api/src/pages/payables-bills.js` (Bills list, FB.list-driven), a new "New Payment" form (new file/route), plus the downstream doc edits listed in §7.
**Supersedes:** the inline single-bill pay-row (`openPayRowData`/`submitPayRow`/`closePayRow`) and the P1-9b multi-bill pay panel (`openMultiPayPanel`/`submitMultiPayPanel`/`closeMultiPayPanel`/`_multiPay*`) in `payables-bills.js` — both deleted outright, replaced by New Payment (§3). Also supersedes the unmerged local branch `fix/keyboard-shortcuts-consolidation-pass` (2026-08-28), which partially attempted the "kill human draft-save" idea without the Draft flag or New Payment redesign — see §6.
**Depends on:** `docs/keyboard-ux-spec.md` §5 (the `~` toggle-verb doctrine — this spec's `~` usage complies with it as written; no doctrine amendment needed, see §1). `agent-readiness-spec.md` / `bank-matching-spec.md` §10.4a (agent-created `bill_draft` path — explicitly unaffected, §4).
**Companions:** `docs/bank-match-bill-settlement-spec.md` (references the `p`/`P` keys directly — needs a follow-up edit once this ships, §7).

---

## 0. Problem

Bill creation and payment recording are currently split across more keys and surfaces than the underlying actions need:

- `p` is overloaded: on a draft row it posts; on a posted/partial row it opens the inline single-bill pay row. Two unrelated actions, one key, disambiguated only by row status.
- `P` opens a second, separate multi-bill pay panel — a third meaning bolted onto the same key family.
- Human "save as draft" (`w` → `bill.draft.save`) and "post" (`p` → `bill.create`/`bill.draft.post`) are today two co-equal, independently-triggered actions, even though in practice most bills are meant to post immediately on entry — draft is the exception, not the common case.

## 1. Bill save — Draft flag + `w`

Human-only (see §4 for why the agent path is untouched). Both `bill-edit.js` and `payables-bills.js` gain a single explicit commit key, `w`, replacing today's `w` (draft-save) / `p` (post) split. A **Draft** flag, default `false`, decides what `w` does.

**Full editor (`bill-edit.js`):**
- New "Draft" toggle field in the header zone, default OFF. Bound to `~` — a reversible flip of the focused form cell, the exact shape `keyboard-ux-spec.md` §5 already ratifies (*"toggles the state of the ACTIVE CELL / focused control"*). No doctrine exception needed.
- `w` branches on the flag:
  - **OFF** → strict validation (today's `validateClient(bill, true)`: expense account per line, ≥1 line, a positive line amount), then commit — `bill.create` for a never-saved bill (skips draft entirely, exactly like today's `postBill()` `!S.billId` branch), or a silent save followed by `bill.draft.post` for a bill that already has a saved draft (today's `postBill()` `S.billId` branch, reused as-is).
  - **ON** → today's loose validation (`validateClient(bill, false)`: partner_name + date only), then `bill.draft.save` only — identical to today's `saveDraft(false)`.
- `p` is removed; its one job ("post bill") is now `w` with Draft OFF.

**Bills list (`payables-bills.js`):**
- The focused new/dirty bill row gets a per-row Draft flag, default off — same shape as the existing Vendors `~` toggle-active precedent that `keyboard-ux-spec.md` §5 already cites as its model case. `~` on the focused row flips it.
- `w` (today: unconditional `bill.draft.save` via `cfg.save`/`api.writeFocused()`) branches on the row's flag exactly as above:
  - **OFF** → validate (see the nuance in §5), then commit via today's `postDraft(row)` logic (`bill.create` direct for `_isNew`, or write-then-`bill.draft.post` for an existing saved draft).
  - **ON** → `bill.draft.save` via `cfg.save`, unchanged.
- `p` is removed from its create/post role here too.

## 2. `y` — advance a saved bill

New row-level verb on Bills, taking over `p`'s second job (open the pay row) and the "post a bill I saved earlier and moved on from" case:

- Focused row **status = draft** → `y` runs `postDraft(row)` (save-if-dirty, then `bill.draft.post`). Same underlying action as `w` with Draft OFF, just reachable without re-opening the row for editing — useful for a draft sitting untouched (including one created via `:bill` or landing from document extraction). This is also the exact action Inbox already binds to `y` for a `bill_draft` Class A item (`queryBillDrafts`, `inbox.js:306` → `bill.draft.post`) — same key, same meaning, two entry points onto the same action.
- Focused row **status = posted or partial** → `y` opens New Payment (§3), pre-scoped to that one bill.
- `p` and `P` are both fully retired from Bills — no key posts or pays directly anymore except through `w`/`y`.

## 3. New Payment form

A new, dedicated screen (an `FB.form`, not `FB.list`) that becomes the *only* way for a human to record a bill payment — single, partial, or multi-bill alike. Replaces the inline pay-row and multi-pay panel outright (not kept as a fallback).

Reachable two ways:
- **Top-bar `+` New menu** (`topbar-chrome-spec.md` §5, itself still "draft, not yet built" — safe to extend) — a new unscoped "New Payment" entry, driven the same way every other `+` entry is: an `action-catalog.js` row flagged `create: true` feeding `newTargets()`. Opens blank; the user picks the vendor/bill(s) manually. This is the **only** entry point for a multi-bill payment — same "same vendor, same currency, status posted/partial, outstanding > 0" qualifying rule `openMultiPayPanel` already enforces today, carried over unchanged.
- **`y` on a posted/partial Bills row** (§2) — opens the same form pre-scoped to that one bill (bill_id, partner, currency, outstanding prefilled as the single line). The user can still add more of that vendor's open bills into the same payment before submitting — same capability today's `P` offers, just reached from a different key with a different default (one bill preselected instead of all qualifying bills).

Fields — the union of today's two forms, unchanged in meaning: payment date (default today), bank/cash account (cash-dropdown, defaults from `localStorage['fb.payAccount.<company>']`, must resolve to an active `cf_category='Cash'` account — same server guard as today, `bills.js:650-657`), an optional reference, an FX rate field shown only for a foreign-currency vendor (defaulted from `fx.rates.get`, overridable), one row per bill in the payment with its outstanding + allocation amount (auto-distributed proportionally off a Total field, same algorithm as today's `_multiPayAutoDistribute`), and a running allocated/total balance check (same warn state as today's `mp-balance`).

**Backend: no changes.** Single-bill submit calls `bill.payment.record` without `allocations` (`recordBillPayment`, `bills.js:645`); multi-bill submit calls it with `allocations` (`recordMultiBillPayment`, `bills.js:743`) — `handleBills` already branches on this (`bills.js:93`). This spec is a pure UI consolidation onto an existing, unmodified backend contract.

## 4. Explicitly unaffected

- Voiding a bill (`x`) and voiding a payment are untouched.
- **Agent-created drafts stay exactly as they are.** `createBill`'s `ctx.actor.actorType === 'agent'` guard (`bills.js:109`) unconditionally forces `status='draft'`, independent of any human-facing flag. The Draft toggle described in §1 is a human-UI-only concept — an agent caller never sees or sets it, and the server-side force branch is not touched by this spec.
- Bank-match auto-settlement (`payment_batch_id`/`method:'bank_match'` in `createBill`, and the FX bank-match settlement work) is a separate, non-human-initiated path, untouched by New Payment.
- Inbox's `queryBillDrafts` (`inbox.js:306`) keeps surfacing every `status='draft'` row company-wide as a Class A `bill_draft` item, agent- or human-authored alike, exactly as today. This spec changes how a human reaches post/pay from Bills — it does not change what lands in Inbox or when.

## 5. Validation-split nuance found in current code

`bill-edit.js` already has two distinct client validators (`validateClient(bill, false/true)`) — §1 reuses them as-is.

`payables-bills.js`'s current validator, `billValidateBuf`, is already the *strict* one — it's used identically for today's `w` (draft-save) and `postDraft`, with no looser "skeleton draft" tier on this surface today. Under this spec, Draft ON keeps using `billValidateBuf` unchanged; Draft OFF needs one small addition — requiring a positive amount on at least one line (`billValidateBuf` currently only checks the amount is numeric, not `> 0`) — to match `bill-edit.js`'s stricter post-time bar. This is the only validation-logic change this spec requires; everything else is which existing validator runs, chosen by the flag.

## 6. Prior art / cleanup

`fix/keyboard-shortcuts-consolidation-pass` (local branch, 2026-08-28, never merged) partially attempted the "`w` posts, not drafts" idea — without the Draft flag or New Payment redesign — and left it half-done (`docs/keyboard-shortcuts-followups.md` #2: the mouse "write" chip still bypassed the kill). This spec supersedes it outright; the branch should be deleted, not merged or mined, once this ships. Its followups doc's #2 becomes moot under this design — the flag makes draft-vs-post an explicit, visible choice rather than a silent default, so the mouse write chip driving `w` is no longer a loophole. Followups #1 (`I` key) and #6 (Class A `bill_draft` reachability in the current client) are unrelated to this spec and should stay open, tracked separately.

## 7. Downstream doc edits (not done by this spec)

- `docs/keyboard-ux-spec.md` — add a Bills/Payables per-page binding entry (§8 pattern) documenting `w`/`~`/`y` per §1–§2.
- `docs/payables-ux-spec.md` — mark the P1-9 inline pay-row section superseded by §3 (already flagged as containing other stale sections per `keyboard-shortcuts-followups.md` #5 — good moment to clean up together).
- `docs/p131-multi-bill-settlement-spec.md` — mark superseded by §3.
- `docs/bank-match-bill-settlement-spec.md` — its line *"`bill.payment.record` (the `p`/`P` keys, `payables-bills.js`) is the only path today that actually settles a bill"* needs the `p`/`P` reference swapped to "New Payment" once this ships.
- `docs/topbar-chrome-spec.md` §5 — add the New Payment `+`-menu entry once built (it already documents the mechanism generically, §5's "raised in conversation as a possible `p`-key or similar addition" note can be resolved by pointing at `y` instead).
- `docs/keyboard-shortcuts-followups.md` — close #2 as moot (§6); leave #1/#6 open.
