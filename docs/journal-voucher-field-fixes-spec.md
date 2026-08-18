# freebooks — Journal Voucher Field Fixes Spec

**Date:** 2026-08-18 · **Status:** PROPOSED · **Scope:** `/:company/journal/voucher` only (header + line fields, read-only/view-mode rendering, reversal rendering). No other FB.form screen is in scope.
**Consumers:** `api/src/pages/journal-voucher.js`, `api/src/journal.js`, `api/src/action-catalog.js`
**Reference implementation (pattern source):** `api/src/pages/bill-edit.js`, `api/src/bills.js`
**Companions:** `ia-spec.md` (§3.2 FB.form contract, §9 verb conventions), `payables-ux-spec.md` (CCY field + cost-center precedent), `fx-automation-spec.md`

---

## 0. Problem Statement

Journal Voucher (`journal-voucher.js`) is the only human-facing entry point for manual double-entry postings. Auditing it against `db/schema.sql`, `journal.js`, and the sibling `bill-edit.js` form surfaces three defects:

1. **Missing: Currency / FX rate.** `journal_entries` carries `currency`, `fx_rate`, `debit_home`, `credit_home` per line, and `journal.post` already accepts and applies `line.currency`/`line.fx_rate` — but the form never collects either. Every manual entry silently posts at `fx_rate = 1.0`, home currency only. `bill-edit.js` exposes a `CCY` field for the equivalent workflow.
2. **Missing: Cost Center.** `journal_entries.cost_center`/`profit_center` exist, `journal.post` derives `profit_center` from `cost_center` server-side, and Master Data has a Cost/Profit Centers tab — but no line on the Journal Voucher form can be tagged with a center. `bill-edit.js` exposes a per-line cost-center field (`.bl-cc`) against the same `center.list` action.
3. **Redundant: Account Code + Account Name.** Each line renders two separate free-text inputs (`.acct-input`, `.acct-name-input`) synced by a JS listener, both wired to the same account-autocomplete source. Only `account_code` is ever read in `postEntry()` — `.acct-name-input` is never submitted. This is UI duplication with no corresponding data need.

This spec addresses only these three items. Per-line customer/vendor tagging and a draft/save-without-posting state are explicitly out of scope (see §7).

---

## 1. Currency (header field)

### 1.1 Design

Add one header field, **Currency**, following the same pattern already ratified on Bills (`bill-edit.js` `be-ccy` + `fxOn`/`baseCcy`):

- Gate on `flags.fxTracking` (from `getRelevanceFlags`, already imported by `journal-voucher.js` but currently only reads `flags.vatRegistered` — extend to also read `fxTracking` and `baseCurrency`).
- `fxTracking === 'true'` → render a visible `CCY` input (3-letter, uppercase, autocomplete off), defaulting to `baseCurrency`, positioned in `.header-fields` after Description.
- `fxTracking !== 'true'` (i.e. `'false'`, the only other value `getRelevanceFlags` returns) → render a hidden input locked to `baseCurrency`, no visible field. No behavior change for single-currency companies.

**Divergence from `bill-edit.js`, deliberate:** `bill-edit.js` line 34 gates on `const fxOn = !flags || flags.fxTracking !== 'off';`. `getRelevanceFlags` (`common.js` line 45) only ever returns `'true'` or `'false'` for this flag, never `'off'` — so `fxOn` is always `true` in `bill-edit.js` today, and its CCY field is unconditionally visible regardless of the setting. That's a pre-existing bug in `bill-edit.js`, not a pattern to copy. This spec uses `=== 'true'`, which is the correct check against the flag's actual values. `bill-edit.js`'s gate should be fixed separately (`!== 'off'` → `=== 'true'`); it is not in scope here.

Currency is **header-level, not per-line** — it applies uniformly to every line in the voucher, the same way the header `Date` field already does in `postEntry()`. Rationale: `bill-edit.js` uses one currency per document; manual journal entries are overwhelmingly single-currency transactions; and this keeps the line grid uncluttered. A mixed-currency batch is out of scope — noted as an open question in §7.

### 1.2 FX Rate

Add a second header field, **FX Rate**, visible only when Currency ≠ base currency:

- On Currency blur/change (and on Date change, if a foreign currency is already set), call `fx.rates.get` and pre-fill the field with the resolved rate. `getEffectiveRate` (`fx.js` line 258) reads its params from `ctx.body`, not top-level — unlike `journal.post`, which reads `lines`/`journalId` at the top level. The call must nest accordingly:

```js
fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({
    action: 'fx.rates.get', companyId: COMPANY,
    body: { fromCurrency: ccy, toCurrency: baseCurrency, date }
  }) })
```
- The field stays editable — the user can override the resolved rate (mirrors the ratified Stated-VAT override pattern on Bills: computed value pre-filled, amber/marked when the user overrides it, sent as-is if present).
- If `fx.rates.get` returns no rate for the date, leave the field blank and require manual entry before posting (validation, §5).

### 1.3 Submission

`postEntry()` reads `entry-ccy` and `entry-fx-rate` once (not per line) and stamps them onto every line object before calling `journal.post`:

```js
var currency = document.getElementById('entry-ccy') ? document.getElementById('entry-ccy').value.trim().toUpperCase() : baseCurrency;
var fxRate   = document.getElementById('entry-fx-rate') ? document.getElementById('entry-fx-rate').value : null;
// ...
lines = lines.map(l => ({ ...l, currency, fx_rate: fxRate ? Number(fxRate) : undefined }));
```

### 1.4 Backend fix required

`journal.js` currently does:

```js
const fxRate = currency === company.currency ? 1.0 : (line.fx_rate || 0);
```

If a foreign currency is posted without an explicit rate, this silently defaults to **0**, zeroing out `debit_home`/`credit_home` — a correctness bug independent of the UI fix. `bills.js` already has the right pattern:

```js
if (bill.fx_rate && Number(bill.fx_rate) > 0) fxRate = Number(bill.fx_rate);
else fxRate = await getRate(currency, company.currency, date);
```

**Change:** `journal.js` must call the same `getRate()` (from `fx.js`) as a fallback instead of defaulting to `0`, for every code path that resolves `fxRate` (manual post, import, reversal-copy). This is a prerequisite for §1.1–1.3 to be safe to ship — exposing a currency field without this fix would let users post foreign-currency entries that silently zero out home-currency balances whenever they leave FX Rate blank.

---

## 2. Cost Center (line field)

### 2.1 Design

Add one line-level field, **Cost Center**, positioned after Line Description (or after Tax Code when VAT is on — final column order is an implementation choice, not a spec requirement). Mirrors `bill-edit.js` exactly:

- Fetch `center.list` once on page load into a module-level array (`var centers = []`), same as `bill-edit.js`'s `S.centers`.
- Render `<input class="cc-input" placeholder="Cost center">` per line.
- Attach an `FB.dropdown` autocomplete filtered to `center_type === 'Cost'`, matching on `center_id`/`name`:

```js
function attachCenterDd(input) {
  if (!window.FB || !FB.dropdown) return;
  FB.dropdown.attach(input, {
    minWidth: 180,
    source: q => {
      q = (q || '').toLowerCase();
      return centers.filter(c => c.center_type === 'Cost')
        .filter(c => c.center_id.toLowerCase().includes(q) || (c.name || '').toLowerCase().includes(q))
        .map(c => ({ primary: c.center_id, secondary: c.name, data: c }));
    },
    onPick: (it, inp) => { inp.value = it.primary; }
  });
}
```

**Divergence from `bill-edit.js`, deliberate:** `centers.js`'s `deriveProfitCenter` (line 44) checks `center.center_type !== 'Cost'` — the stored/validated value is capitalized `'Cost'`. `bill-edit.js` calls `attachCenter(row.querySelector('.bl-cc'), 'cost')` (line 421), filtering on lowercase `'cost'` — which matches nothing against real data. That's a second pre-existing bug in `bill-edit.js`, not a pattern to mirror; copying it here would ship a cost-center autocomplete that never returns results. This spec deliberately uses `'Cost'`. `bill-edit.js`'s filter should be fixed separately; it is not in scope here.

- No separate Profit Center field — `journal.post` already derives `profit_center` from `cost_center` server-side (existing `deriveProfitCenter` call). This matches `bill-edit.js`, which also exposes cost center only.
- Field is optional. Blank → `cost_center: null`, unchanged current behavior.

### 2.2 Submission

`postEntry()`'s line-mapping adds:

```js
cost_center: tr.querySelector('.cc-input').value.trim() || null,
```

### 2.3 Validation

`journal.js`'s `enrichAndValidate` already calls `deriveProfitCenter` (`centers.js`) for any line carrying a `cost_center`, which throws `Unknown cost_center: ${id}`, `${id} is not a Cost center`, `Cost center ${id} is inactive`, or `Cost center ${id} has no profit center assigned` as appropriate — so server-side rejection of a bad cost center already exists and this spec does not need to add it.

**Caveat:** that call is itself gated — `enrichAndValidate` only runs `deriveProfitCenter` when `isDerivationEnabled(companyId)` returns true (reads the `center_derivation_enabled` setting). `bill-edit.js`'s cost-center field is *not* gated on this setting (always rendered), so this spec follows the same precedent and always shows the field — but during the pre-cutover window (flag off, which appears to be the default), an invalid `cost_center` string typed into this field will be accepted and stored with **no server-side validation at all**, silently. That's existing, intentional rollout behavior per `centers.js`'s own doctrine comments, not something this spec should change — but the client-side autocomplete (§2.1) is the only real safeguard against typos while the flag is off, which is a good reason to keep it wired to `center.list` rather than treating it as a free-text field.

---

## 3. Account Code + Account Name consolidation (redundant field)

### 3.1 Design

Replace the two columns (`Code`, `Account Name`) with a single **Account** column and a single input per line, `.acct-input`, using the existing `accountsMap` (code → name) as the autocomplete source. Behavior:

- Typing filters on both code and name (unchanged `attachAcctDd` filter logic, now attached to one field instead of two).
- Picking a suggestion sets the input's visible value to `"CODE — Name"` and stores the canonical code on `input.dataset.code`.
- Typing an exact code directly (no dropdown pick) still resolves against `accountsMap` on blur/input and rewrites the display to `"CODE — Name"` form, same as today's code→name sync, just collapsed into one field instead of two.
- If the typed text doesn't resolve to a known code, `dataset.code` is cleared and the existing "Unknown account(s)" validation in `postEntry()` fires exactly as it does today (validation logic is unchanged, only the field count).

```js
function pickAccount(acct, input) {
  input.value = acct.code + ' — ' + acct.name;
  input.dataset.code = acct.code;
}
```

### 3.2 Submission

```js
account_code: tr.querySelector('.acct-input').dataset.code
  || tr.querySelector('.acct-input').value.trim().split(' — ')[0],
```

(Falls back to parsing a leading code if the user typed a raw code and tabbed away without triggering the resolve handler — same tolerance the current two-field version has today via the code input's own value.)

### 3.3 Read-only / view-mode rendering

Three other render sites in `journal-voucher.js` currently emit Code and Name as two `<td>`s and must be collapsed to one, for consistency with the edit-mode column change:

- The view-mode (`?batch=`) line loader (`~line 498`)
- `renderPostedVoucher()` (`~line 547`)
- The reversal original-entry read-only rows (`~line 726`)

Each becomes: `'<td>' + esc(l.account_code) + ' — ' + esc(accountsMap[l.account_code] || '') + '</td>'`, replacing the two-`<td>` version. Table `<thead>` changes from `<th>Code</th><th>Account Name</th>` to a single `<th>Account</th>`.

### 3.4 Reversal pre-fill

The reversal-pick pre-fill logic (`~line 738–742`), which currently sets `codeIn.value` and `nameIn.value` separately, is replaced with a single call to `pickAccount({ code: l.account_code, name: accountsMap[l.account_code] || '' }, acctInput)`.

**Currency/FX Rate must also be pre-filled here — separate gap, same function.** `applyReversalLines(batchId, ref, lines)` (`~line 690`) already reads `lines[0].journal_id` to pre-fill the Journal dropdown, but reads nothing from `lines[0].currency`/`lines[0].fx_rate`. Every line in the fetched batch carries its own `currency`/`fx_rate` (schema, §0); under this spec's header-level design (§1.1) they're uniform across the batch, so `lines[0]` is representative — mirror the existing `jId` pattern:

```js
var ccy = (lines[0] && lines[0].currency) || baseCurrency;
var rate = (lines[0] && lines[0].fx_rate) || null;
if (document.getElementById('entry-ccy')) document.getElementById('entry-ccy').value = ccy;
if (ccy !== baseCurrency && document.getElementById('entry-fx-rate') && rate) {
  document.getElementById('entry-fx-rate').value = rate;
}
```

Without this, reversing a foreign-currency entry silently drops back to the Currency field's default (base currency) and posts the reversal at `fx_rate = 1.0` — the exact home-currency-corruption failure mode §1.4 exists to prevent, just reached through the reversal path instead of a fresh entry.

### 3.5 View-mode and posted-voucher rendering must also show Currency

`renderViewMode()` (`~line 478`) and `renderPostedVoucher()` (`~line 528`) populate the read-only header (Date, Journal, Description) from the loaded batch but never Currency — a posted foreign-currency voucher, viewed back, currently gives no indication it wasn't posted in the home currency. Both functions gain one line, symmetric with the existing `descEl.value = viewBatchDesc` / equivalent:

```js
var ccyEl = document.getElementById('entry-ccy');
if (ccyEl) { ccyEl.value = <batch's line currency>; ccyEl.readOnly = true; }
```

Displayed whenever the field exists in the DOM (i.e. whenever `fxTracking === 'true'`), regardless of whether the specific voucher being viewed happens to be in the base currency — consistent with how Journal/Description render read-only unconditionally today. FX Rate is not shown read-only here (not required to reconstruct what was posted, since `debit_home`/`credit_home` are already the posted figures) — open question in §7 if reviewers want it anyway.

### 3.6 Cell-type / keyboard notes

No change to FB.form cell semantics — this remains a plain text input with `FB.dropdown.attach`, same as today's `.acct-input`. Removing `.acct-name-input` removes one Tab stop per line. Resulting Tab order follows column position, not a fixed sequence specified here: if Cost Center ends up placed after Tax Code (§7's default), the order is Account → Debit → Credit → Line Description → Tax Code → Cost Center; if Cost Center is placed elsewhere, Tab order changes accordingly. No cell earlier in the row should ever route to one later in a different order than left-to-right column order (existing FB.form convention).

---

## 4. Line/Header Field Summary (after this spec)

| Header | Line |
|---|---|
| Date | Account (single combined field) |
| Journal | Debit / Credit |
| Doc Nr (auto, read-only) | Line Description |
| Description | Tax Code (VAT) + computed VAT — unchanged, VAT-gated |
| **Currency** *(new, fxTracking-gated)* | **Cost Center** *(new)* |
| **FX Rate** *(new, shown when Currency ≠ base)* | — |

---

## 5. Validation Rules (additions to `postEntry()` client-side checks + `journal.post` server-side)

- If `fxTracking === 'true'` and Currency is set to a non-base currency with no resolvable rate and no manual override → block post: *"Exchange rate required for `<CCY>`."* (mirrors the existing `diff !== 0` disable pattern on `btn-post`).
- Currency, if entered, must be a 3-letter code present in `/db/currencies.json` — the same static list `bill-edit.js` fetches (`fetch('/db/currencies.json')`, line ~240) for its own `be-ccy` field; fetch it the same way for parity rather than hardcoding a list in `journal-voucher.js`.
- Cost Center: no new client-side existence check is needed beyond what `deriveProfitCenter` already enforces server-side (§2.3) when `center_derivation_enabled` is on. When it's off, there is currently no server-side rejection of an unknown `cost_center` string — the client-side autocomplete (§2.1) is the only guard, which is expected/unchanged rollout behavior, not a defect this spec introduces or needs to close.
- Account field: unchanged — must resolve to a known `account_code`, else `"Unknown account(s): …"` (existing check, now checked once per line as today).

---

## 6. Non-Goals (explicitly out of scope, per prior discussion)

- No customer/vendor ("Name") tagging per line.
- No draft/save-without-posting state for manually-typed vouchers — `w`/"Post Entry" remains the only save path, unchanged.
- No mixed-currency lines within a single voucher (Currency stays header-level, applied uniformly). If a genuine need for per-line currency on manual entries surfaces later, it is a separate spec.
- No UI change to Bills (`bill-edit.js`) — it already has both fields; it's the reference pattern, not a target of this work.

---

## 7. Open Questions

- Should Cost Center sit before or after Tax Code in column order? No functional impact — deferred to implementation/design review.
- Should the FX Rate override, once edited by hand, render amber like the Stated-VAT override on Bills, to visually flag a manual override at a glance? Recommended for consistency but not blocking.

---

## 8. Rollout / Testing

- `journal-voucher` is explicitly the single-screen key-coverage gate (`tests/keys-coverage.mjs` / `npm run test:keys`, per `ia-spec.md` §11) — the new Currency/FX Rate/Cost Center inputs and the collapsed Account field must all pass that gate (live `FB.keys` set, non-empty hints, every visible interactive control keyboard-managed) before merge.
- `journal.js`'s `getRate()` fallback (§1.4) needs a contract test asserting a foreign-currency line with no `fx_rate` supplied resolves via the FX table/provider rather than defaulting to `0`.
- Existing contract tests asserting `account_code`-only submission continue to pass unchanged (§3 doesn't change the wire shape of `lines[]`, only how the code is captured client-side).

---

## 9. Changelog

| Date | Change |
|------|--------|
| 2026-08-18 | Initial draft: currency/FX rate + cost center added, account code/name fields consolidated |
| 2026-08-18 | Review pass: fixed `fxTracking` gate (was mis-stated as matching `bill-edit.js`; `bill-edit.js`'s `!== 'off'` gate is a separate pre-existing bug, called out not copied) · fixed `center_type` filter capitalization (`'Cost'`, not `'cost'`; `bill-edit.js` has the same lowercase bug, called out not copied) · added Currency/FX Rate reversal pre-fill (§3.4, was silently missing) · added Currency display to view-mode/posted rendering (§3.5, was silently missing) · corrected `fx.rates.get` call shape to nest params under `body` · added `/db/currencies.json` fetch-path parity note · clarified `deriveProfitCenter` validation is gated by `center_derivation_enabled` and not unconditional |
