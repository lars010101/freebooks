# freebooks — Journal Voucher Field Fixes Spec

**Date:** 2026-08-18 · **Status:** PROPOSED · **Scope:** `/:company/journal/voucher` only (header + line fields, read-only/view-mode rendering, reversal rendering). No other FB.form screen is in scope.
**Consumers:** `api/src/pages/journal-voucher.js`, `api/src/journal.js`, `api/src/action-catalog.js`
**Reference implementation (pattern source):** `api/src/pages/bill-edit.js`, `api/src/bills.js`
**Companions:** `ia-spec.md` (§3.2 FB.form contract, §9 verb conventions), `payables-ux-spec.md` (CCY field + cost-center precedent), `fx-automation-spec.md`

---

## 0. Problem Statement

Journal Voucher (`journal-voucher.js`) is the only human-facing entry point for manual double-entry postings. Auditing it against `db/schema.sql`, `journal.js`, and the sibling `bill-edit.js` form surfaces three defects:

1. **Missing: Currency / FX rate.** `journal_entries` carries `currency`, `fx_rate`, `debit_home`, `credit_home` per line, and `journal.post` already accepts and applies `line.currency`/`line.fx_rate` — but the form never collects either. Every manual entry silently posts at `fx_rate = 1.0`, home currency only. `bill-edit.js` exposes a `CCY` field for the equivalent workflow.
2. **Missing: Cost Center *and* Profit Center.** `journal_entries.cost_center`/`profit_center` exist, and `journal.post` supports two distinct server-validated paths — derive `profit_center` from a supplied `cost_center`, *or* accept a `profit_center` directly with no cost driver (`enrichAndValidate`'s `if (line.cost_center) {...} else if (line.profit_center) {...}`) — but no line on the Journal Voucher form can be tagged with either. `bill-edit.js` exposes a per-line cost-center field (`.bl-cc`) against the same `center.list` action, but has no profit-center field, and `bills.js`'s own derivation logic has no direct-profit-center branch to expose one for — Bills structurally can only ever be cost-side. Since AR/invoicing is dropped from this build (README: "dropped/deferred from the current cycle; nav and page scaffolding remain in place but inactive"), **JV is currently the only form in the app where that direct-profit-center branch is reachable at all** — this isn't parity-for-parity's-sake, it's the one place a human can book a revenue-side or otherwise cost-driver-less entry against a profit center.

   *Review question answered:* whether mdab_se's Master Data currently has a profit center with no cost center rolling up into it can't be checked — mdab_se doesn't use cost/profit centers at all today (no centers configured). This is being designed as a general, industry-standard capability rather than one validated against live configuration: revenue-side and non-cost-driven entries (revenue recognition, intercompany allocations, non-operating income, reclasses/corrections) are the standard case for direct profit-center posting in dimensional-accounting systems generally (SAP CO, NetSuite, Dynamics), independent of what's configured for any one company. Because the need is general rather than immediate, §2.1 below detects whether a company has actually configured any centers and hides both fields entirely until it has — the reviewer's "UI complexity for no practical use" concern is addressed by not showing that complexity to companies that aren't using the feature, rather than by leaving it out of the capability.
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

## 2. Cost Center & Profit Center (line fields)

### 2.1 Visibility: detected, not toggled

**Revised from the prior draft.** The original version of this section gated Cost Center/Profit Center visibility behind a `centersOn` flag sourced from `center_derivation_enabled` — mirroring how `fxTracking` gates Currency. On further review that's the wrong signal, for a specific, verified reason: `centers.js`'s own docstring describes `center_derivation_enabled` as a rollout/cutover gate specifically for *derivation strictness* (whether a Cost center must carry a `profit_center_id`, whether auto-derivation runs on posting) — not a general "has this company adopted centers" flag. Confirmed against `index.js`'s `center.upsert` handler (`~line 1194`): creating a Cost or Profit center works fine with the flag off; it's only checked for one narrow rule (`else if (await isDerivationEnabled(companyId)) throw ... requires a profit_center_id`). So a company can fully populate Master Data → Cost/Profit Centers without ever touching that flag — meaning gating JV's fields on it would hide the columns from a company that has genuinely set the feature up, purely because a separate, narrower migration flag happens to still be off.

**Design: visibility is detected from whether the company has configured at least one active center, not from any setting.** Computed server-side at page-render time — the same architectural pattern already used for `vatOn`/`fxOn` (`getRelevanceFlags`, called once inside the Express handler, baked into the initial HTML) — rather than a client-side check after `center.list` resolves, which would cause the columns to visibly pop in after page load:

```js
// getRelevanceFlags (common.js), alongside the existing settings/company query
const [centerRow] = await query(
  `SELECT 1 FROM centers WHERE company_id = @cid AND is_active = true LIMIT 1`,
  { cid: String(companyId) }
);
// ...
return { ..., centersConfigured: !!centerRow };
```

`journal-voucher.js`'s page handler reads `flags.centersConfigured` the same way it will read `flags.fxTracking` (§1.1) — rendering the `Cost Center`/`Profit Center` `<th>`s and inputs in the initial HTML only when true, nothing client-side-conditional. The moment an owner creates their first center in Master Data, the columns appear on the next JV page load — no separate feature switch to discover or flip, which resolves the confirmed gap flagged in the prior draft (no Settings UI exists for `center_derivation_enabled`, and now none is needed for this purpose).

**Known, accepted tradeoff — not silently resolved:** `journal.js`'s `enrichAndValidate` still gates its actual reference validation (`deriveProfitCenter`, and the direct-profit-center `center_type === 'Profit'` check) behind `isDerivationEnabled` — a separate condition from `centersConfigured`. A company that has created centers (fields visible) but hasn't turned `center_derivation_enabled` on (mid pre-cutover migration, per that flag's own documented purpose) can type an unknown or wrong-type value into either field and have it silently accepted with no server-side rejection. Decoupling basic reference validation ("does this resolve to a real, correctly-typed, active center") from derivation-strictness ("should the system auto-derive and require full linkage") would close this cleanly, and arguably should happen regardless of this spec — but that's a change to `journal.js`'s/`index.js`'s existing validation semantics, not a UI decision, and isn't proposed here. Flagged for the centers-rollout owner as a follow-up, not blocking this spec.

**Also flag for `bill-edit.js`, separately:** its cost-center field is unconditionally rendered — no detection, no flag, just always visible regardless of whether the company has any centers configured. Not in scope to fix here, but worth noting alongside the two other `bill-edit.js` issues this spec surfaced: the `fxOn` gate bug (§1.1, above) and the lowercase `center_type` filter bug (§2.2, below) — three separate pre-existing `bill-edit.js` issues found while building this spec, none of them this spec's job to fix.

### 2.2 Design — Cost Center

Add one line-level field, **Cost Center**, positioned after Line Description (or after Tax Code when VAT is on — final column order is an implementation choice, not a spec requirement). Mirrors `bill-edit.js` exactly, aside from visibility gating (§2.1, no precedent in `bill-edit.js`) — this half of §2 otherwise has a direct precedent; §2.3 below does not:

- Fetch `center.list` once on page load into a module-level array (`var centers = []`), same as `bill-edit.js`'s `S.centers`.
- Render `<input class="cc-input" placeholder="Cost center">` per line.
- Attach the shared autocomplete helper (defined once, in §2.3, since Profit Center needs the identical logic filtered on a different `center_type`), called as `attachCenterDd(input, 'Cost')`:

```js
attachCenterDd(row.querySelector('.cc-input'), 'Cost');
```

**Divergence from `bill-edit.js`, deliberate:** `centers.js`'s `deriveProfitCenter` (line 44) checks `center.center_type !== 'Cost'` — the stored/validated value is capitalized `'Cost'`. `bill-edit.js` calls `attachCenter(row.querySelector('.bl-cc'), 'cost')` (line 421), filtering on lowercase `'cost'` — which matches nothing against real data. That's a second pre-existing bug in `bill-edit.js`, not a pattern to mirror; copying it here would ship a cost-center autocomplete that never returns results. This spec deliberately uses `'Cost'`. `bill-edit.js`'s filter should be fixed separately; it is not in scope here.

- Field is optional. Blank → `cost_center: null`, unchanged current behavior.

### 2.3 Design — Profit Center (direct, no cost driver)

Add a second line-level field, **Profit Center**, next to Cost Center. **No precedent in `bill-edit.js` for this one** — `bills.js`'s derivation logic (`if (bill.cost_center && await isDerivationEnabled(...)) { derive }`) has no direct-profit-center branch at all, so there was never anything to mirror for Bills. This field exists specifically because `journal.js`'s `enrichAndValidate` does have that branch (`else if (line.profit_center) { validate center_type === 'Profit' }`), and — with AR/invoicing dropped from this build (README) — JV is the only form that can currently reach it.

```js
function attachCenterDd(input, type) { // type: 'Cost' | 'Profit'
  if (!window.FB || !FB.dropdown) return;
  FB.dropdown.attach(input, {
    minWidth: 180,
    source: q => {
      q = (q || '').toLowerCase();
      return centers.filter(c => c.center_type === type)
        .filter(c => c.center_id.toLowerCase().includes(q) || (c.name || '').toLowerCase().includes(q))
        .map(c => ({ primary: c.center_id, secondary: c.name, data: c }));
    },
    onPick: (it, inp) => { inp.value = it.primary; }
  });
}
```

(Single parameterized helper — same body as would otherwise have been written twice — both fields attach through it: `attachCenterDd(row.querySelector('.cc-input'), 'Cost')` in §2.2, `attachCenterDd(row.querySelector('.pc-input'), 'Profit')` here.)

Field is optional. Blank → `profit_center: null`.

### 2.4 Mutual exclusivity

The backend's precedence is `if (cost_center) derive-and-overwrite-profit_center; else if (profit_center) validate-as-typed`. If both fields are filled, `journal.post` will silently discard whatever the user typed into Profit Center and replace it with the derived value from Cost Center — a silent-overwrite trap if the UI lets both sit filled at once. The form must prevent this rather than let the server's precedence surprise the user:

```js
function attachCenterExclusivity(ccInput, pcInput) {
  ccInput.addEventListener('input', () => { if (ccInput.value.trim()) { pcInput.value = ''; pcInput.disabled = true; } else { pcInput.disabled = false; } });
  pcInput.addEventListener('input', () => { if (pcInput.value.trim()) { ccInput.value = ''; ccInput.disabled = true; } else { ccInput.disabled = false; } });
}
```

Typing in either field clears and disables the other. Clearing a field re-enables its counterpart. This makes the row's actual behavior (cost-side derivation *or* direct profit-side tagging, never both) visible at the point of entry instead of only discoverable after a confusing post result.

### 2.5 Submission

`postEntry()`'s line-mapping adds:

```js
cost_center: tr.querySelector('.cc-input').value.trim() || null,
profit_center: tr.querySelector('.pc-input').value.trim() || null,
```

### 2.6 Validation

`journal.js`'s `enrichAndValidate` already calls `deriveProfitCenter` (`centers.js`) for any line carrying a `cost_center`, which throws `Unknown cost_center: ${id}`, `${id} is not a Cost center`, `Cost center ${id} is inactive`, or `Cost center ${id} has no profit center assigned` as appropriate. For a line carrying `profit_center` directly (no `cost_center`), the `else if` branch throws `${line.profit_center} is not a valid profit center` if the `center_type` isn't `'Profit'`. Both paths already exist server-side and this spec does not need to add either.

**Caveat, applies to both fields:** both branches sit inside `if (derivationEnabled)` — `enrichAndValidate` only runs either check when `isDerivationEnabled(companyId)` returns true (`center_derivation_enabled`). Unlike the prior draft of this spec, that's now a genuinely *different* condition from what gates the fields' visibility (§2.1's `centersConfigured`, sourced from whether any center exists — not from this setting). So the "visible but not validated" gap flagged as resolved in the prior draft is back, specifically for a company with centers configured but the derivation flag still off: the fields show, autocomplete works, but a typed value that happens to be wrong (unknown id, wrong type, inactive) is accepted with no server-side rejection. §2.1 documents this as a known, deliberate tradeoff rather than something this section should silently paper over. The client-side autocomplete (§2.2/§2.3) is the only real safeguard against typos in that state, which is a good reason to keep both wired to `center.list` rather than free-text fields regardless of how the flag question gets resolved.

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
| **Currency** *(new, fxTracking-gated)* | **Cost Center** *(new, shown when a center is configured)* |
| **FX Rate** *(new, shown when Currency ≠ base)* | **Profit Center** *(new, shown when a center is configured, mutually exclusive with Cost Center)* |

---

## 5. Validation Rules (additions to `postEntry()` client-side checks + `journal.post` server-side)

- If `fxTracking === 'true'` and Currency is set to a non-base currency with no resolvable rate and no manual override → block post: *"Exchange rate required for `<CCY>`."* (mirrors the existing `diff !== 0` disable pattern on `btn-post`).
- Currency, if entered, must be a 3-letter code present in `/db/currencies.json` — the same static list `bill-edit.js` fetches (`fetch('/db/currencies.json')`, line ~240) for its own `be-ccy` field; fetch it the same way for parity rather than hardcoding a list in `journal-voucher.js`.
- Cost Center / Profit Center: no new client-side existence check is needed beyond what `deriveProfitCenter` / the direct-profit-center branch already enforce server-side (§2.6) when `center_derivation_enabled` is on. Note that's a narrower condition than field visibility (§2.1's `centersConfigured`) — a company with centers configured but that flag still off will see the fields with no server-side rejection of a bad value typed into them. Documented as a known tradeoff in §2.1/§2.6, not something this spec closes.
- Mutual exclusivity (§2.4) is enforced client-side only; there is no server-side rejection of a payload carrying both `cost_center` and `profit_center` on one line — `journal.post` just applies its existing precedence (cost-center derivation wins) silently. Client-side prevention is the only safeguard, which is why §2.4 is not optional.
- Account field: unchanged — must resolve to a known `account_code`, else `"Unknown account(s): …"` (existing check, now checked once per line as today).

---

## 6. Non-Goals (explicitly out of scope, per prior discussion)

- No customer/vendor ("Name") tagging per line.
- No draft/save-without-posting state for manually-typed vouchers — `w`/"Post Entry" remains the only save path, unchanged.
- No mixed-currency lines within a single voucher (Currency stays header-level, applied uniformly). If a genuine need for per-line currency on manual entries surfaces later, it is a separate spec.
- No UI change to Bills (`bill-edit.js`) — it already has the cost-center field (unconditionally visible, unlike this spec's §2.1 detection) and has no backend path for a direct profit-center posting to expose (§0); it's the reference pattern for §2.2 only, not a target of this work. Its missing visibility detection is noted (§2.1) but not fixed here.

---

## 7. Open Questions

- Should Cost Center / Profit Center sit before or after Tax Code in column order, and adjacent to each other? No functional impact — deferred to implementation/design review.
- Should the FX Rate override, once edited by hand, render amber like the Stated-VAT override on Bills, to visually flag a manual override at a glance? Recommended for consistency but not blocking.
- Should disabling the "off" field in §2.4 (mutual exclusivity) also visually gray it out / show a tooltip explaining why, or is a plain `disabled` attribute sufficient? Recommended: a short inline hint (e.g. "cleared — cost center derives this") rather than a silent disable, so the behavior isn't mysterious.
- **No longer a visibility blocker, but still a real gap for validation strictness:** there is no Settings UI anywhere in the app to toggle `center_derivation_enabled` — grepped `settings.js`, `master-data.js`, `company.js`, and `admin-page.js`/`admin.js` for it, zero matches. It can only be flipped via a direct `settings.save` API call. Under §2.1's detection-based design this no longer blocks a company from *using* Cost Center/Profit Center on JV — creating a center makes the fields appear regardless of this flag (verified: `center.upsert` doesn't require it). What it still blocks is the stricter server-side behavior (§2.6): auto-derivation of `profit_center` from `cost_center`, and mandatory `profit_center_id` linkage on new Cost centers, only turn on once this flag is set — and right now no owner can set it through the product. Worth raising with whoever owns the centers rollout as a real (if lower-urgency than before) product gap, separate from this spec's scope.

---

## 8. Rollout / Testing

- `journal-voucher` is explicitly the single-screen key-coverage gate (`tests/keys-coverage.mjs` / `npm run test:keys`, per `ia-spec.md` §11) — the new Currency/FX Rate/Cost Center/Profit Center inputs and the collapsed Account field must all pass that gate (live `FB.keys` set, non-empty hints, every visible interactive control keyboard-managed) before merge.
- §2.4's mutual-exclusivity behavior needs its own test: filling Cost Center clears/disables Profit Center and vice versa, and a payload can never be submitted with both populated.
- §2.1's detection means Cost Center/Profit Center are testable end-to-end simply by seeding one active row in `centers` for a test company — no settings flag needs to be set for the fields to appear (unlike Currency/FX Rate, §1, which still needs `fxTracking` set). A separate test should confirm the fields stay hidden with zero centers seeded, and appear once exactly one exists.
- A separate test should also cover §2.6's caveat directly: seed a center, leave `center_derivation_enabled` off, and confirm the fields are visible but an invalid `cost_center`/`profit_center` value is still accepted by `journal.post` — documenting the known gap rather than assuming it's closed.
- `journal.js`'s `getRate()` fallback (§1.4) needs a contract test asserting a foreign-currency line with no `fx_rate` supplied resolves via the FX table/provider rather than defaulting to `0`.
- Existing contract tests asserting `account_code`-only submission continue to pass unchanged (§3 doesn't change the wire shape of `lines[]`, only how the code is captured client-side).

---

## 9. Changelog

| Date | Change |
|------|--------|
| 2026-08-18 | Initial draft: currency/FX rate + cost center added, account code/name fields consolidated |
| 2026-08-18 | Review pass: fixed `fxTracking` gate (was mis-stated as matching `bill-edit.js`; `bill-edit.js`'s `!== 'off'` gate is a separate pre-existing bug, called out not copied) · fixed `center_type` filter capitalization (`'Cost'`, not `'cost'`; `bill-edit.js` has the same lowercase bug, called out not copied) · added Currency/FX Rate reversal pre-fill (§3.4, was silently missing) · added Currency display to view-mode/posted rendering (§3.5, was silently missing) · corrected `fx.rates.get` call shape to nest params under `body` · added `/db/currencies.json` fetch-path parity note · clarified `deriveProfitCenter` validation is gated by `center_derivation_enabled` and not unconditional |
| 2026-08-18 | Added a direct **Profit Center** field (§2.3) alongside Cost Center, plus client-side mutual exclusivity (§2.4): `journal.js` has a validated direct-profit-center-only posting branch (`enrichAndValidate`'s `else if (line.profit_center)`) that `bills.js` structurally cannot reach and that has no other UI in the app now that AR/invoicing is dropped — JV is the only reachable path for it. Updated §0, §4, §5, §6, §7, §8 accordingly. |
| 2026-08-18 | Review pass: answered the "concrete use case?" question re: direct profit-center posting (§0) — mdab_se has no centers configured, so this is designed as a general/industry-standard capability, not one validated against live data (per explicit instruction: "this is a general feature, not tailored to my current needs"). Added §2.1 visibility gating behind `center_derivation_enabled` (superseded by the next entry) so Cost Center/Profit Center don't appear for companies not using the feature — corrects an inconsistency where the original design mirrored `bill-edit.js`'s ungated (and now-flagged-as-buggy) behavior instead of this spec's own §1 precedent. Confirmed via grep that no Settings UI currently exists to toggle `center_derivation_enabled` at all. Renumbered §2.2–§2.6 accordingly and fixed a stale §2.6 caveat that had contradicted the new gating. |
| 2026-08-18 | Design question: should center visibility be an explicit toggle or detected from configured data? Verified `center.upsert` (`index.js` ~line 1194) doesn't require `center_derivation_enabled` to create a center, removing the circularity concern — data can exist independently of the flag. Reworked §2.1: visibility is now detected server-side from whether the company has any active center configured (`centersConfigured`, a lightweight `EXISTS` query added to `getRelevanceFlags`, computed and baked into the page the same way `vatOn`/`fxOn` already are), not gated behind `center_derivation_enabled` — that flag's documented purpose is migration/derivation strictness, not feature adoption, and repurposing it for visibility was the wrong call in the prior entry. Explicitly re-opened and documented the "visible but not validated" gap this reintroduces for centers configured before the flag is on (§2.1, §2.6, §5) rather than let the prior entry's "resolved" claim stand uncorrected. Downgraded §7's missing-toggle item from a visibility blocker to a validation-strictness gap. Updated §0, §4, §6, §8 and this changelog accordingly. |
