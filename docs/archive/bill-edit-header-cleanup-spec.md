# Bill Editor Header Cleanup: Drop AP Account, Add Memo — Spec

**Status:** Ratified 2026-08-17
**Scope:** `api/src/pages/bill-edit.js` only — the full-page bill editor served at `GET /:company/bill/edit`. The tree-table quick-entry page (`api/src/pages/payables-bills.js`) is cited as prior art in §0.2 but is not modified by this spec.
**Depends on:** nothing outstanding — both changes land on top of already-shipped, already-working backend behavior (§0.2, §0.3).

---

## 0. Context and scope

This spec covers two independent, small changes to the same file, bundled together because both are header-area cleanups to the same form and touch overlapping code (`gatherBill()`, `prefillFromDraft()`):

1. **Remove the visible "CR: AP account" input.** Resolve it silently instead (partner default → company default), matching how the tree-table page already does it.
2. **Add a bill-level memo/notes field.** The column and every write path already exist server-side; only the UI input is missing.

### 0.1 Why these two together

Both changes touch the same header markup, the same `S` state object, and the same `gatherBill()`/`prefillFromDraft()` pair, so splitting them into separate patches would mean touching the same lines twice. §1 and §2 are still independently revertible — neither depends on the other shipping.

### 0.2 The AP-account field is already an outlier, not a new pattern

`payables-bills.js` (the tree-table quick-entry surface) **never shows an AP-account input**. It resolves `ap_account` purely through hidden dataset fields, populated when a partner is picked or a typed name resolves on blur:

```js
// payables-bills.js, billAttachPartner() onPick handler
inp.dataset.apAccount = v.default_ap_account || companyDefaultAp || '';
```

The DEV NOTE above that function is explicit about this being deliberate: *"ap_account / expense_account / partner_id / currency are not cfg columns... AP/expense travel on the partner input's datasets."* `bill-edit.js` is the one surface that instead renders `ap_account` as a required, freely-editable visible input (`#be-ap`). §1 brings `bill-edit.js` in line with the pattern `payables-bills.js` already established — this is a consistency fix, not a new design.

### 0.3 The memo field is already fully wired server-side

`bills.description` is a plain nullable `VARCHAR` (`db/schema.sql` line 224) and every write path already reads and persists it:

| Path | File:line | Status |
|---|---|---|
| `createBill` | `api/src/bills.js:264` | `description: bill.description \|\| null,` already in `billRow` |
| `saveDraftBill` (insert) | `api/src/bills.js:1133` | same, already in `billRow` |
| `saveDraftBill` (update-existing-draft) | `api/src/bills.js:1145` | `description=@description` already in the `UPDATE ... SET` clause and params |
| `postDraftBill` (draft→post passthrough) | `api/src/bills.js:1268` | `description: bill.description,` already in the explicit rebuilt object |
| `updateBill` | `api/src/bills.js:1010` | already an allowed field in the `setParts` allowlist |
| `getBill` | `api/src/bills.js:986-991` | `SELECT *` — already returns it |

No backend change is required for §2. The only gap is client-side: `bill-edit.js`'s `gatherBill()` never reads a description value and `prefillFromDraft()` never writes one back into the DOM — there is no `<input>`/`<textarea>` for it anywhere in the file. (`api/src/pages/bill-detail.js`, the posted-bill view, is in the same position: it calls `bill.update` twice but only ever echoes `billData.description || ''` back unchanged to avoid clobbering it — it never lets the user edit it either. See §5.)

**Stale as of 2026-09-06:** both halves of this observation are superseded. `bill-edit.js` now has a `be-memo` field wired through `gatherBill()`/`prefillFromExisting()` (renamed from `prefillFromDraft`), and `bill-detail.js` no longer exists — it's merged into `bill-edit.js` (Stage 2 of that merge), whose header fields lock once a bill is posted, `description`/memo included; the "echo it back unchanged" pattern doesn't apply either, since the merged `saveMetaField()` sends only the one field that actually changed (`bill.update` does a real partial update).

---

## 1. Change 1 — Remove the visible "CR: AP account" field

### 1.1 Goal

Delete the `#be-ap` input and its column from the header grid. Keep resolving `ap_account` exactly as before (partner default, else company default, else a clear validation error at post time) — just without a visible field for it.

### 1.2 Markup

**Before** (`bill-edit.js` lines 100–106):

```html
<div class="be-grid-header">
  <label class="be-gh-partner">Partner * <input id="be-partner-name" autocomplete="off" placeholder="start typing…"></label>
  <label class="be-gh-ap">CR: AP account <input id="be-ap" autocomplete="off"></label>
  <label class="be-gh-row2" style="grid-column:1">Bill date * <input id="be-date" type="date"></label>
  <label class="be-gh-row2">Due date <input id="be-due" type="date"></label>
  <label class="be-gh-row2" style="${vatOn ? 'grid-column:4' : 'grid-column:3'}">Bill no <input id="be-ref" autocomplete="off" placeholder="e.g. INV-123"></label>
</div>
```

**After:**

```html
<div class="be-grid-header">
  <label class="be-gh-partner">Partner * <input id="be-partner-name" autocomplete="off" placeholder="start typing…"></label>
  <label class="be-gh-row2">Bill date * <input id="be-date" type="date"></label>
  <label class="be-gh-row2">Due date <input id="be-due" type="date"></label>
  <label class="be-gh-row2">Bill no <input id="be-ref" autocomplete="off" placeholder="e.g. INV-123"></label>
</div>
```

The per-field `style="grid-column:..."` attributes on Bill date/Bill no are dropped along with the `vatOn` ternary that drove them — see §1.3, this only existed to dodge around the AP-account cell.

### 1.3 CSS simplification

The entire reason `.be-grid-header`'s `grid-template-columns` was a `vatOn`-dependent 6-vs-5-column split mirroring the line table's widths was to align `#be-ap` (grid-column 5, "CR: AP account") above "DR: Expense account" in the table below — see the existing comment: *"Grid header mirrors the table column widths so CR: AP account aligns vertically with DR: Expense account below."* Once the field is gone, that constraint disappears entirely, and `.be-grid-header` no longer needs to know about `vatOn` at all.

**Before:**

```css
.be-grid-header {
  display:grid;
  grid-template-columns: ${vatOn ? '36% 13% 13% 15% 21% 2%' : '36% 13% 15% 21% 2%'};
  column-gap:0;
  align-items:end;
  margin-bottom:12px;
}
...
/* Partner spans full width of row 1. Row 2 has bill date, due date,
   bill no on the left, and CR: AP account aligned with the DR: Expense
   account column (col 5 with VAT, col 4 without). */
.be-grid-header .be-gh-partner {
  grid-row: 1;
  grid-column: 1 / -1;
  padding-right:8px;
}
.be-grid-header .be-gh-ap {
  grid-row: 2;
  grid-column: ${vatOn ? '5 / 6' : '4 / 5'};
}
.be-grid-header .be-gh-row2 { grid-row: 2; }
```

**After:**

```css
.be-grid-header {
  display:grid;
  grid-template-columns: repeat(3, 1fr);
  column-gap:0;
  align-items:end;
  margin-bottom:12px;
}
...
/* Partner spans full width of row 1. Bill date, due date, and bill no
   share row 2 evenly — no longer tied to the line table's column widths
   now that CR: AP account (the thing that required the alignment) is gone. */
.be-grid-header .be-gh-partner {
  grid-row: 1;
  grid-column: 1 / -1;
  padding-right:8px;
}
.be-grid-header .be-gh-row2 { grid-row: 2; }
```

(`.be-gh-ap` rule deleted outright.) Row-2 items auto-place into columns 1–3 in DOM order under `grid-auto-flow: row` (the default), so no explicit `grid-column` is needed on them anymore.

### 1.4 State: capture the resolved AP account without displaying it

Add a new field to the page's `S` state object (`bill-edit.js` line ~164):

```js
const S = {
  partners: [], accounts: [], vatCodes: [], centers: [], currencies: [],
  billId: editId || null,
  selectedPartnerId: null,  // partner_id from dropdown pick (bills-partner-fk-spec §4.2)
  selectedApAccount: null,  // resolved ap_account — no visible field; §1 of bill-edit-header-cleanup-spec.md
  stagedFiles: [],
  saving: false,
  savedSnapshot: null,
};
```

**Partner-pick handler** (`wireHeader()`, lines 252–267) — replace the `#be-ap` write with a state write, mirroring `payables-bills.js`'s `dataset.apAccount` pattern:

```js
onPick: (it, inp) => {
  inp.value = it.primary;
  const v = it.data;
  S.selectedPartnerId = v.partner_id || null;  // bills-partner-fk-spec §4.2
  S.selectedApAccount = v.default_ap_account || null;  // §1.4 — carried silently
  if (FX_ON && v.default_currency && !document.getElementById('be-ccy').value) document.getElementById('be-ccy').value = v.default_currency;
  if (v.payment_terms_days) {
    const d = document.getElementById('be-date').value;
    if (d) {
      const due = new Date(d); due.setDate(due.getDate() + Number(v.payment_terms_days));
      document.getElementById('be-due').value = due.toISOString().slice(0, 10);
    }
  }
  inp.dispatchEvent(new Event('input', { bubbles: true }));
},
```

(The `if (v.default_ap_account && !document.getElementById('be-ap').value) ...` line is deleted — folded into the `S.selectedApAccount` assignment above.)

**Free-text clear** (lines 272–273) — when the user types a name instead of picking from the dropdown, `selectedPartnerId` is already cleared (§0.2 of `bills-partner-fk-spec.md`'s free-text behavior). `selectedApAccount` must be cleared alongside it, or a stale partner's AP account could survive onto an unrelated free-typed vendor:

```js
const _partnerInput = document.getElementById('be-partner-name');
if (_partnerInput) _partnerInput.addEventListener('input', () => { S.selectedPartnerId = null; S.selectedApAccount = null; });
```

### 1.5 `prefillFromDraft()` — preserve `ap_account` when editing an existing draft

This is a regression-guard, not a new feature: without it, opening an existing draft and re-saving would silently null out its `ap_account` — the exact same class of bug `bills-partner-fk-spec.md` §3.3 flagged for `postDraftBill`'s field whitelist (a value that exists on the loaded row but is never re-captured into client state before the next save).

**Before** (line 227): `document.getElementById('be-ap').value = bill.ap_account || '';`

**After:** `S.selectedApAccount = bill.ap_account || null;`

### 1.6 `wireHeader()` — drop the dropdown attachment

Delete line 269: `attachAcct(document.getElementById('be-ap'));` — the element no longer exists. (`attachAcct()` itself stays; it's still used for the line-level `.bl-acct` expense-account inputs.)

### 1.7 `gatherBill()`

**Before** (line 436): `ap_account: document.getElementById('be-ap').value.trim() || undefined,`

**After:** `ap_account: S.selectedApAccount || undefined,`

### 1.8 `validateClient()` — no visible field to mark, so don't try

**Before** (line 449, inside the `forPost` block): `if (!bill.ap_account) { missing.push('AP account'); mark('be-ap'); }`

**After:** deleted outright — do not replace it with a different client-side check.

This isn't a gap: `validateBill()` (`api/src/validation.js` line 143) already runs *after* `applyCompanyDefaults()` server-side and already produces a clean `"AP account is required"` (or `"AP account {code} does not exist in COA"`) error if, after both the partner-level and company-level fallbacks, nothing resolved. `postBill()`'s existing catch handler (`bill-edit.js` line 502-504) already surfaces that message verbatim in the status bar. This mirrors the file's own existing precedent for the FX-rate-missing case (`bills.js` line ~135-140, `"No FX rate found for ... Add the rate in Settings → Exchange Rates."`), which is likewise server-validated only, with no matching client-side field or pre-check. Duplicating the check client-side would also have nothing to `mark()` now that `#be-ap` doesn't exist.

**Required addition:** The AP-account field is never shown under any circumstances — not even when resolution fails. When a company has no default AP account configured anywhere, the user discovers this only at post time. To make that discoverable without a visible field, append a setup hint to the specific error in `postBill()`'s catch handler: detect `e.message.includes('AP account is required')` and append ` — set a default AP account for this vendor or in Settings → Chart of Accounts.` This is the sole UX remedy; no conditional AP field, no pre-flight check, no inline editing of AP account from the bill editor. The user must fix it in Settings (company default) or partner data (vendor default).

---

## 2. Change 2 — Expose a bill-level memo field

### 2.1 Goal

Add a single input the user can type an internal note into, wired to the already-fully-functional `bills.description` column (§0.3). No backend changes.

### 2.2 Markup

Add as a third row to the same `.be-grid-header` div, full width (same pattern as the Partner row):

```html
<div class="be-grid-header">
  <label class="be-gh-partner">Partner * <input id="be-partner-name" autocomplete="off" placeholder="start typing…"></label>
  <label class="be-gh-row2">Bill date * <input id="be-date" type="date"></label>
  <label class="be-gh-row2">Due date <input id="be-due" type="date"></label>
  <label class="be-gh-row2">Bill no <input id="be-ref" autocomplete="off" placeholder="e.g. INV-123"></label>
  <label class="be-gh-memo">Memo <input id="be-memo" autocomplete="off" placeholder="internal note (optional)"></label>
</div>
```

CSS addition:

```css
.be-grid-header .be-gh-memo {
  grid-row: 3;
  grid-column: 1 / -1;
}
```

**Element choice:** a plain `<input>`, not a `<textarea>`, to match the rest of the header's uniform 32px-height fields and keep it visually a "one more field," not a document-notes box. `FB.form`'s default zone `cells()` selector (`fb-form.js` line 56, `input,select,textarea`) already supports a `<textarea>` if a future revision wants multi-line notes — that's a drop-in swap, not a framework change, should the one-line input prove too cramped in practice.

Not marked required (no `*`), and no client-side validation is added — an empty memo is a normal, expected state.

### 2.3 `gatherBill()`

Add one field (line ~436-438 area):

```js
description: document.getElementById('be-memo').value.trim() || undefined,
```

### 2.4 `prefillFromDraft()`

Add one line where the other header fields are restored (near line 226):

```js
document.getElementById('be-memo').value = bill.description || '';
```

### 2.5 FB.form zone interaction

No changes needed to the `zones` config (`bill-edit.js` line ~566-577). The `header` zone's `rows()` already returns the whole `.be-grid-header` element, and (per §1.3's note on the default `cells()` selector) the new `#be-memo` input is automatically picked up as a navigable cell — same as `#be-ref` today.

---

## 3. Rollout order

1. **§1** (remove AP field) and **§2** (add memo field) can ship together in one PR — they touch the same handful of functions and there's no reason to sequence them, unlike `bills-partner-fk-spec.md`'s guard rollout (§6 there), which had an actual safety reason to phase.
2. Verify manually (or via the existing bill-creation test suite, §4) **before** merging:
   - A bill created by picking a vendor with a `default_ap_account` posts using that account, with no visible field showing it.
   - A bill created for a vendor with no default, in a company with a default `AP`-flagged account, posts using the company default.
   - A bill created for a vendor with no default, in a company with **no** default AP account configured either, fails at post with the existing "AP account is required" message — not a raw 500 / stack trace.
   - Editing an existing draft (that has a stored `ap_account`) and re-saving does not blank it out (§1.5's regression guard).
   - A memo typed on a new bill round-trips through `bill.create` → `bill.get` → reload correctly.
   - A memo typed on a draft survives `bill.draft.save` → `bill.draft.post` → `bill.get` (exercises `postDraftBill`'s passthrough, §0.3 confirms it's already wired, this just confirms the UI didn't break it).

---

## 4. Test coverage

Extend the existing bill-creation test suite (same suite `bills-partner-fk-spec.md` §7 targets) with:

- `ap_account` resolution precedence via the API directly (not the UI): vendor default wins over company default when both are present; company default is used when the bill payload omits `ap_account` and the vendor has none; a clear `INVALID_INPUT` / "AP account is required" error when neither exists. (This exercises `bills.js`, not `bill-edit.js` — confirms the server side this UI change now depends on entirely, with no client-side backstop.)
- `description` round-trips: `bill.create` with a description → `bill.get` returns it; `bill.draft.save` → `bill.draft.post` → `bill.get` preserves it (regression test for the `postDraftBill` passthrough, in the same spirit as the existing `partner_id` passthrough test called out in `bills-partner-fk-spec.md` §7).

No new UI/browser tests exist in this repo for `bill-edit.js` today (confirmed: `tests/` has no headless-browser suite for it) — these two changes don't introduce a need for one on their own.

---

## 5. Out of scope

- **`payables-bills.js`**: already correct (§0.2) — not touched.
- **`bill-detail.js`** (posted-bill view) — merged into `bill-edit.js` 2026-09-06; no longer a separate page. The posted-bill (locked) mode there disables the memo field along with the rest of the header, same effective behavior this bullet describes, just one file now instead of two.
- Any character-limit / max-length enforcement on the memo — `bills.description` is an unbounded `VARCHAR` in DuckDB; no limit exists today for `vendor_ref` either, so none is being introduced here for consistency.
- Detecting "no AP account configured anywhere" *before* post time (e.g. graying out the Post button) — the required setup hint in §1.8 is the extent of this spec's UX handling; a pre-flight check would need a new read (company defaults + vendor default) on every keystroke/partner-pick, which is more machinery than this cleanup warrants.
- **Conditionally showing the AP-account field** when no default resolves. The AP-account field is permanently removed from the bill editor under all circumstances. The user's only remedy for a missing AP account is to configure it in Settings → Chart of Accounts (company default) or on the vendor/partner record (partner default). This is an explicit design decision, not a deferred item.

---

## 6. Acceptance criteria

1. `#be-ap` does not exist anywhere in the rendered page; the header grid no longer depends on `vatOn`.
2. Creating a bill for a vendor with a configured `default_ap_account` posts successfully using that account, with no AP-account input visible anywhere on the page.
3. Creating a bill for a vendor with no default, where the company has a COA account flagged `default_role='AP'`, posts successfully using that company default.
4. Creating a bill for a vendor with no default, where the company also has no default configured, fails at post with the existing clear `"AP account is required"` server message (not a blank/generic error, not a client-side crash from a missing `mark()` target).
5. Opening an existing draft with a stored `ap_account`, changing an unrelated field, and re-saving does not clear `ap_account`.
6. A new `Memo` field is visible on the form, optional, and round-trips correctly through: direct create, draft-save-then-edit-then-resave, and draft-save-then-post.
7. No existing header field (Partner, Bill date, Due date, Bill no, CCY) changes behavior, tab order, or keyboard-nav position beyond the layout shift caused by the removed/added columns.

---

## 7. File-by-file change list

| File | Change |
|---|---|
| `api/src/pages/bill-edit.js` | Remove `#be-ap` markup, `.be-gh-ap` CSS rule, and the `vatOn`-dependent grid-template-columns split (§1.2–1.3); add `S.selectedApAccount`, update partner `onPick` and free-text-clear handlers (§1.4); update `prefillFromDraft()` to restore `ap_account` into state, not a field (§1.5); drop `attachAcct(#be-ap)` (§1.6); update `gatherBill()`'s `ap_account` source (§1.7); drop the `validateClient()` AP-account check (§1.8); add `#be-memo` markup + `.be-gh-memo` CSS (§2.2); add `description` to `gatherBill()` (§2.3) and to `prefillFromDraft()` (§2.4). |

No changes to `api/src/bills.js`, `api/src/validation.js`, `db/schema.sql`, or any other page — both changes are entirely contained in this one file (§0.2, §0.3).
