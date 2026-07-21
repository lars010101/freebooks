# freebooks — Architecture & UX Review + Roadmap

**Date:** 2026-07-20 · **Basis:** full three-agent code review at HEAD `601d0d1` · **Status:** agreed direction; P0 in execution

---

## 0. Status update — 2026-07-22

**Landed since the review:** P0-1…P0-5 ✅ (PR #1 — idempotency keys + unique constraints, single error envelope + transitional fetch shim, `journal.entry.update` lockdown, dispatch-level audit on every mutating action, admin endpoint bearer-gated). P1-2 ✅ (seed harness + 17 contract tests, `node --test` in `api/`). P1-3 **half** — fb-core (FB.mode/FB.keys/FB.nav/FB.util) exists; Bills ✅ and Vendors ✅ migrated (Vendors took the Bills model wholesale; cell cursor deleted); Journal, Bank, Settings pending. P1-5 ✅ (VAT warnings surfaced). **Dropdown unification** ✅ (executed under the informal label "P2-1a/b/c" on branch `p2/fb-dropdown` — folded into this roadmap as **P1-7**): one `FB.dropdown` component replaced all 9 custom dropdowns + every data-entry `<datalist>` across Bills, Vendors, journal-new, bank, bank-import, settings. `bill-new.js` deliberately untouched (P1-4 rebuilds it). Also fixed en route: bank-import's entire page script had been a browser SyntaxError since ship (template-escape bug).

**New finding — the gap in the "middleware" answer is the READ side, not a missing layer.** The command side (action RPC) is now hardened and agent-testable as prescribed. But every screen hand-assembles its view model client-side: page load fans out to multiple action calls + per-row follow-ups (bills: vendor.list + bill.list + bill.lines per unfold; bank: accounts + journals + reconciliation + balances; bank-import: accounts + journals + bills). That means N+1 round-trips, duplicated assembly logic in template JS, and no server-side place to put derived data (aging buckets, running balances, match suggestions). **Proposal (P1-8 — APPROVED by magnus 2026-07-22; v1 DONE on branch `p1/read-models`):** complement the command API with page-shaped read endpoints — one request per screen, server-joined. CQRS-lite: commands stay action-RPC + idempotent + audited; queries become read models. **v1 shipped `view.bills` + `view.bank` as catalog actions on the existing dispatch** (not separate REST routes — one unified path, manifest-discoverable, viewer role). Pages migrate onto them in P1-4/P1-3; later views (`view.vendors`, `view.journal`, `view.bill`) follow as pages need them.

**Open by priority:** P1-1 action catalog/schemas (unlocks MCP, generates contract tests) → P1-8 read models → P1-4 bill editor rebuild (biggest visible UX win; kills the third entry UI) → P1-6 "?" overlay → P1-3 remainder (journal/bank/settings onto FB.keys) → P2 accounting completeness (year-end close, FX reval monetary-only, `bill_lines` subledger, server-computed draft totals, VAT convention unify) → P3 scope (AR, feeds).

---

## 1. Verdict

1. **Payables-as-standard is the right call.** The vim-modal tree-table with direct post and per-line accounts is a genuinely differentiated, coherent design. The rest of the app should be refactored to match it — but only after the pattern is extracted into shared code (see §4, P1-8).
2. **The "middleware API" already exists.** `POST /api` action-RPC (~70 actions) with business logic server-side *is* the middleware layer. The gap is not a missing layer — it is that the existing layer is **uncontracted** (no schema/catalog), **unsafe to retry** (no idempotency, no unique constraints), **inconsistent** (two error channels), and **unauthenticated** (self-asserted `userEmail`, open admin SQL endpoint).
3. **UX dissatisfaction is structural, not aesthetic.** Four different keyboard/navigation implementations across tabs, two parallel mode systems bridged by `stopImmediatePropagation`, dead discoverability features (`?` button, `:` palette), and stale hints. Fix by extracting one shared core, not by polishing each tab.

---

## 2. Current state

### 2.1 Architecture

- Single Node/Express process; DuckDB via `@duckdb/node-api`; raw SQL inline in every handler; idempotent `db/schema.sql` re-application as "migrations" (no version tracking).
- **RPC-over-single-endpoint:** `POST /api` `{action, companyId, userEmail, ...}` → `ACTION_ROLES` permission map (`index.js`) → module switch. ~70 actions across bills, journal, bank, FX, VAT, COA, reports, settings, permissions, setup.
- REST-ish extras: `GET /api/:company/report?type=pl|bs|cf|tb|gl&format=csv`, `GET /health`, `POST /api/upload`, `GET /api/attachments/:id`, and **`POST /api/admin/query` — arbitrary SQL, unauthenticated** (P0-5).
- Frontend: server-rendered template strings in `api/src/pages/*.js` (no framework, no build). `payables-bills.js` emits ~2,537 LOC of client JS. SPA-ish `fbNavigate` swaps `#page-main` and re-executes inline scripts.
- **Zero tests.** No test script, no test files; CI only builds/pushes the Docker image.

### 2.2 Accounting / data logic

**Strengths (keep):**
- Void-not-delete: posted bills void with automatic journal reversal; paid/partial bills refuse void. Journal entries never deleted — reversal entries only, double-reverse guarded.
- Period lock enforced server-side (`validation.js`, `bills.js`, `journal.reverse`, import).
- Draft→post is UPDATE-in-place: preserves `bill_id`, `created_at`, attachments.
- Tax-exclusive bill entry; supplier-stated VAT override with tolerance `max(flat, pct×expected)` — warn, not block; reverse-charge read-only.
- Exact-date-only FX resolution; settlement FX gain/loss via booking-rate method; `integrity()` macro as detective control.

**Gaps (evidence):**

| # | Finding | Evidence | Severity |
|---|---------|----------|----------|
| 1 | `journal.entry.update` rewrites posted lines — no period-lock check, no audit | `journal.js:32-66` | **High** — violates append-only ledger |
| 2 | `audit_log` wired in exactly one place | `journal.js:443` (import only) | **High** — no accountability |
| 3 | No PK/unique on `bills`/`journal_entries`; no FKs anywhere. Retried `bill.create` duplicates the bill + journal lines | `schema.sql:41,129`, `bills.js:202` | **High** — blocks agent automation |
| 4 | No year-end close to retained earnings; BS injects "unallocated net income" live | `reports/render.js:118-167` | Medium |
| 5 | FX revaluation includes **Equity** accounts — IAS 21 revalues monetary items only | `fx.js:196-265` | Medium |
| 6 | Two VAT conventions coexist: bills tax-exclusive vs `journal.post` tax-inclusive gross split | `bills.js` vs `vat.js:computeVatSplit` | Medium |
| 7 | No `bill_lines` subledger — posted bill lines exist only as journal entries; drafts as JSON | schema | Medium — no subledger-vs-GL control |
| 8 | Auth effectively optional: permission check skipped when `userEmail` omitted; no tokens/sessions | `index.js:132` | **High** for any non-local use |
| 9 | No AR/invoicing (stub page), no bank feeds (CSV only) | README, `receivables.js` | Scope |

### 2.3 UX state

- **Reference standard:** Payables → Bills (vim-modal tree-table, bill-level INSERT, direct `p` post, per-line AP/expense accounts, supplier-stated VAT override).
- **Divergent implementations:** Vendors uses cell-nav with different verbs (`d`/`~` vs `x`); `bill-new.js` is a **third, conflicting bill-entry UI** still linked from "+ Bill" and violates the spec (manual FX-rate input); settings/journal/bank/dashboard are old form-style with `pt` typography violations; receivables is a 34-line stub.
- **Fragile duality:** `cursor._mode` (page) vs `_fbVimMode` (common.js) coexist via capture-phase `stopImmediatePropagation`.
- **Discoverability broken:** "?" button has no handler; `:` palette dispatches to undefined `fbCmdDispatch`; footer hints stale ("o new bill/line"); no help overlay.
- **Warnings swallowed:** backend VAT tolerance warnings are returned but never rendered (`_sendPost` handles errors only).
- **Duplication:** `esc`/`fmtDate`/`statusBadge`/account-autocomplete/keyboard-nav reimplemented 3–4× each across pages.
- **Dead code:** `bill.draft.preview` endpoint + `.preview-row` CSS, pagination in `payables-bills.js`, `.bak` files, `fbOpenCmdPalette` no-op.

---

## 3. The API / middleware question

**Recommendation: harden the existing layer; do not build a new one.**

The client already sends raw inputs and the server computes everything (FX, VAT + tolerance, journal construction, period lock). That is exactly the right trust boundary for agent-driven testing. What is missing, in priority order:

1. **Idempotency** — agents retry; today a retry double-posts.
2. **One error envelope** — today: always-HTTP-500 *and* HTTP-200-with-`{created:false, errors}`; two incompatible channels make assertions unreliable.
3. **Machine-readable action catalog** — JSON Schema per action at `GET /api/actions`; agents get self-discovery, we get contract tests nearly free.
4. **Auth** — token-based; `userEmail` self-assertion is not auth. Admin SQL endpoint must be gated or removed.
5. **Optional, high value:** an **MCP server** over the catalog — agents (including Hermes profiles) then drive freebooks as native tools.

**Explicitly rejected:** rewriting to REST for its own sake (action-RPC + catalog gives the same toolability without churn); a separate middleware service (adds latency/ops, solves nothing); replacing DuckDB (fine at this scale; the API insulates it).

**Testing rule going forward:** no feature ships UI-first. API action + schema + contract test first; UI as a thin client. UI automation shrinks to ~5 smoke checks (page loads, mode toggles, row renders) — visuals only.

---

## 4. Roadmap

### P0 — API trust (makes the core agent-testable)

| # | Item | Acceptance criteria |
|---|------|---------------------|
| P0-1 | **Idempotency keys + unique constraints.** `Idempotency-Key` header (or `idempotencyKey` body field) on posting actions (`bill.create`, `bill.draft.post`, `bill.void`, `journal.post`, `journal.reverse`, `journal.import`, `bank.process`, `fx.revaluation_post`). Stored responses replayed verbatim with `Idempotent-Replay: true`. UNIQUE constraints on `bills.bill_id`, `journal_entries.entry_id` (+ natural keys where clean). | Retried `bill.create` with same key returns the same `bill_id`; exactly one bill and one balanced journal batch in DB. Duplicate key during in-flight request does not double-execute. |
| P0-2 | **Single error envelope.** All failures: `{ok:false, error:{code, message, details?}}` with mapped HTTP codes (400 INVALID_INPUT, 403 FORBIDDEN, 404 NOT_FOUND, 409 CONFLICT/PERIOD_LOCKED, 500 otherwise). Remove the 200-with-`{created:false,errors}` channel in `bills.js`. Update ALL frontend fetch call sites. Preserve VAT tolerance warnings as `data.warnings` on success. | `curl` invalid bill → HTTP 400 + envelope; nonexistent entity → 404; locked period → 409. Frontend renders envelope errors in status bar; no `alert()` regressions. Template-string syntax check passes for every touched page. |
| P0-3 | **`journal.entry.update` lockdown.** Period-lock check; refuse entries belonging to a bill batch (`bill_id` set — use `bill.void`); refuse reversed/reversing entries; write audit row. | Locked period → 409; bill-batch entry → 409 with guidance; audit row present. |
| P0-4 | **Audit wiring.** `auditLog()` on every mutating action: bill create/post/void, journal post/reverse/update/import, settings save, COA save/update/delete, VAT codes, permissions, company save, FX revaluation post. | Each action leaves an `audit_log` row with user, action, entity, details JSON. |
| P0-5 | **Admin endpoint auth.** `/api/admin/query` requires `Authorization: Bearer $FREEBOOKS_ADMIN_TOKEN`; if the env var is unset the endpoint returns 403 (disabled). README documented. | No token → 403; wrong token → 403; correct token → works. |

### P1 — Contract & consistency

- **P1-1 Action catalog:** ~~zod schemas per action~~ ✅ **DONE 2026-07-22** (PR #2 foundation + branch `p1/action-catalog` HEAD): 70-action catalog in `api/src/action-catalog.js` (role/mutating/idempotent/audit/description/params), live manifest at `GET /api/actions`, dispatch-level validation — required params AND declared types enforced (400 naming the field). Plain param tables instead of zod (zero deps, sufficient at this scale; revisit if nested payload schemas become necessary).
- **P1-2 Seed harness + contract tests:** scripted test-company setup (jurisdiction COA, periods, vendors, bills); `node:test` + supertest suite over the catalog; CI gate (extend workflow beyond docker build).
- **P1-3 Shared UI core:** one mode manager, one key dispatcher, one nav abstraction, one utils module (`esc`, `fmtDate`, `statusBadge`, autocomplete). Migrate Bills onto it; then Vendors, Journal, Bank, Settings follow the payables pattern. Eliminate the `_fbVimMode`/`cursor._mode` duality. **Status 2026-07-22:** fb-core exists (FB.mode/FB.keys/FB.nav/FB.util); Bills ✅ and Vendors ✅ migrated (Vendors adopted the Bills interaction model wholesale — cell cursor deleted); sidebar hints generated from binding tables on both tabs. Remaining: Journal, Bank, Settings.
- **P1-4 Replace `bill-new.js` with a shared full-page bill editor** (agreed 2026-07-20): the foldable tree-table stays the default creation path for common bills; the new page is the **escape hatch for complex bills** (many lines, attachments, per-line centers). Same INSERT-mode semantics (Tab traversal, Esc saves-and-returns, same bindings), same endpoints, one shared editor component for create-complex and edit. `bill-detail.js` remains the read/management surface for posted documents. Gets its own spec section before implementation.
- **P1-5 Surface VAT tolerance warnings** in the status bar (no new visual chrome — per magnus's clutter rule).
- **P1-9 Payment matching UX** (approved by magnus 2026-07-22 — he said "go ahead with p1-5" responding to a chat message that mislabeled this item; P1-5 was already shipped). Spec in payables-ux-spec.md §P1-9. Manual `bill.payment.record` from the Bills list (`p` on posted bills → inline payment row), payment history on unfold, import-match hardening (kill silent amount-only auto-link → confirm-required suggestions), `bill.payment.void` unwind. Settlement reuses the extracted import-approve core (FX split included). Deferred: multi-bill settlement, bank-tab manual match, tolerance tiers.
- **P1-6 Discoverability:** "?" opens a which-key-style overlay of the current mode's bindings; hints and overlay generated from the same binding table as the dispatcher (single source of truth — cannot go stale); fix or remove the `:` palette.

### P2 — Accounting completeness

- **P2-1** Year-end close routine to retained earnings (replaces live "unallocated net income" injection).
- **P2-2** FX revaluation: monetary items only (drop Equity).
- **P2-3** `bill_lines` subledger table + AP-subledger-vs-GL control report.
- **P2-4** Unify VAT/amount conventions (tax-exclusive everywhere; convert `journal.post` path). Also: `bill.draft.save` currently trusts a client-computed `bill.amount` — the server should compute draft totals from lines like `createBill` does at post (found via contract tests).
- **P2-5** MCP server over the action catalog.
- **P2-6 (candidate)** User-editable keybindings in Settings (raised by magnus 2026-07-22). Recommendation: build only AFTER all tabs migrate onto FB.keys — bindings are declarative data, so a remap layer (per-user overrides, conflict detection, reset-to-default) then covers the whole app in one shot. Industry reference: accounting software generally doesn't offer rebinding; power tools (Linear, Superhuman) do — fits the keyboard-first philosophy. Priority pending magnus.

### P3 — Scope

- **P3-1** AR/invoicing module built on the payables pattern (customers, invoices, AR aging, receipts).
- **P3-2** Bank feeds (beyond CSV import).

---

## 5. Standing rules (from this review)

1. Every feature: API action + schema + contract test **first**, UI second.
2. The posted ledger is append-only; corrections via reversing entries, never mutation.
3. Every mutating action is idempotent (key accepted) and audited.
4. Backend warnings must have a UI channel; warnings never silently dropped.
5. Spec docs updated in the same commit as behavior changes (payables-ux-spec precedent).
6. Dead code deleted, not commented — including endpoints, CSS, and `.bak` files.
