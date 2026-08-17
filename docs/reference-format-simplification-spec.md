# Reference Format Simplification — `{CODE}/{YEAR}/{NNNNN}` → Plain Doc Number

**Status:** Proposal — open for ratification (not yet implemented)
**Issue:** [#175](https://github.com/lars010101/freebooks/issues/175)
**Depends on:** `journal_id` column on `journal_entries` (landed on `main`, added as part of the opening-balance work)
**Touches:** `api/src/journal.js`, `api/src/pages/journal.js`, `api/src/pages/journal-new.js`, `api/src/sie-export.js`, `reports/render.js`, `api/src/action-catalog.js`
**Schema impact:** none (Option A, recommended below) — see §2 for the alternative that does require a schema change

---

## 0. Context and scope

### 0.1 Current behavior

`reference` is minted by `getNextReference` / `getNextReferenceBatch` in `journal.js`:

```js
// journal.js:518-541 (current)
async function getNextReference(companyId, journalId, year) {
  await exec(`INSERT INTO journal_sequences (company_id, journal_id, year, last_seq)
              VALUES (@companyId, @journalId, @year, 0) ON CONFLICT DO NOTHING`, ...);
  await exec(`UPDATE journal_sequences SET last_seq = last_seq + 1
              WHERE company_id = @companyId AND journal_id = @journalId AND year = @year`, ...);
  const rows = await query(
    `SELECT j.code, s.last_seq FROM journal_sequences s
     JOIN journals j ON j.journal_id = s.journal_id
     WHERE s.company_id = @companyId AND s.journal_id = @journalId AND s.year = @year`, ...);
  const { code, last_seq } = rows[0];
  return `${code}/${year}/${String(last_seq).padStart(5, '0')}`;
}
```

The counter itself (`journal_sequences`) is **already** keyed `PRIMARY KEY (company_id, journal_id, year)` — i.e. already per-journal, per-year. The `{CODE}/{YEAR}/` prefix is a *display* artifact assembled at read time from a join to `journals.code`; it carries no information the row doesn't already have elsewhere once `journal_id` exists on `journal_entries` itself.

### 0.2 Why the prefix is redundant now

- **Journal code**: derivable from `journal_entries.journal_id` → `journals.code` (a real FK join), not string-parsing.
- **Year**: derivable from `journal_entries.date`.

So the only irreducible information in the current string is the sequence number itself.

### 0.3 What this spec covers

- Choosing a numbering scheme (§2) and recommending one.
- The exact code sites that mint, display, filter, or parse `reference`, verified against `main` (§1, §3) — including sites not listed in the issue body.
- A migration stance for historical `reference` values, plus a **blocking question** about `journal_id` backfill that must be answered before the display/filter changes are safe (§4).
- A testing checklist (§5) and open questions for ratification (§6).

**Non-goals:** renumbering/rewriting historical `reference` values; changes to `journal_sequences`' schema (Option A needs none); AR numbering (AR is deferred/inactive per the README); anything about SIE `#VER` series numbering itself, which turns out to be unrelated to this field (§3.4).

---

## 1. Full inventory of `reference`-format-dependent code

Verified directly against `main`. The issue's "Code touched" list covers most of this; the items below not present in the issue's list (1.3, 1.10, 1.11, and the `journal.search` gap in §3.5) were found by reading the actual call sites rather than assuming the issue's list was exhaustive.

| # | File | Site | Depends on format how | Breaks if format changes? |
|---|------|------|------------------------|----------------------------|
| 1.1 | `journal.js` | `getNextReference` | Assembles `${code}/${year}/${seq}` | This *is* the change |
| 1.2 | `journal.js` | `getNextReferenceBatch` | Same assembly, batched | This *is* the change |
| 1.3 | `journal.js` | `listEntries` (`journal.list` action) | `journalCode` param does `reference LIKE journalCode + '/%'` | **Yes** — silently returns nothing once there's no `/` prefix. Not named in the issue but is a real, live filter — and it's driven by a live UI surface, see 1.10. |
| 1.4 | `pages/journal.js` | register column `{ field: 'reference', filterType: 'text' }` | Displays and free-text-filters the raw string | No — cosmetic only. Filtering by a bare `MISC` or `2027` substring stops working, but that's a UX loss, not breakage. |
| 1.5 | `pages/journal-new.js` | `showStatus('Posted ✓ ' + (d.reference \|\| d.batchId))` | Just displays it | No |
| 1.6 | `pages/journal-new.js` | `viewBatchRef = lines[0].reference \|\| ''` | Just displays it | No |
| 1.7 | `pages/journal-new.js` | reversal search results row: `var ref = r.reference \|\| r.batch_id;` | Just displays it | No |
| 1.8 | `pages/journal-new.js` | **"Match journal by reference prefix"** (`applyReversalLines`, ~line 573) | `ref.split('/')[0]` used to pre-select the journal dropdown on reversal | **Yes** — this is the one real functional break in the entry-flow UI. See §3.3. |
| 1.9 | `sie-export.js` | `COALESCE(reference, description, '')` as voucher free text | Uses `reference` only as a text fallback | No — see §3.4, the issue's assumption here is inaccurate. |
| 1.10 | `reports/render.js` | **Journal Report page — "Journal Code:" filter box** (`#f-journal`, `doSearch()`, `buildJournal`) | A free-text input (placeholder `e.g. BANK`) sends `journalCode: <typed value>` straight into the `journal.list` payload — this is the live UI client for 1.3's backend filter | **Yes — this is the site that makes 1.3 a real, user-facing regression rather than a theoretical one.** Not named in the issue. If 1.3's backend param is touched without updating this box (or vice versa), the filter becomes a **silent no-op**: the box still accepts typed input and shows no error, it just stops narrowing results — worse than a crash, because it fails quietly. See §3.2 for the resolution. |
| 1.11 | `action-catalog.js` | `journal.list`'s `params` declaration (`journalCode: { type: 'string' }`); `journal.post`'s `description` string, which embeds the literal text `{CODE}/{YYYY}/{NNNNN}` | This is the introspectable action schema (`GET /api/actions`), and it's what the MCP server exposes as tool definitions to agents | **Yes, if left stale.** Not a runtime crash, but a silently wrong contract: an agent (or any external client) reading the catalog would be told a param name that no longer matches the backend, and a reference format that's no longer true. See §3.2. |

### 1.12 Verified non-dependent (checked, not assumed)

Three more files touch `reference` and were checked to rule out format-dependence, since the issue's list stops at the four files it names:

- **`bank.js`** — two read-only queries (`SELECT je.reference ...` in the reconciliation list and the uncleared-lines list) treat it as opaque display data, `GROUP BY`'d alongside `batch_id`/`date`/`description`. No parsing. The one place `bank.js` *mints* a reference (bulk pre-allocation for bank-import postings) calls `getNextReferenceBatch` directly and stores whatever string comes back — it doesn't assemble or interpret the format itself, so it inherits 1.2's fix for free.
- **`bills.js`** — `apRef` (used on every AP-bill journal line) comes from `getNextReference(companyId, apJournalId, year)` directly (line 318) — same situation as `bank.js`, inherits the fix. Separately, `bills.js` also has a `reference` column on **`bill_payments`** (`paymentReference`) — this is a *different*, user-supplied field for a vendor's payment reference/remittance advice, unrelated to the journal-voucher numbering scheme this spec addresses. Not in scope.
- **`settlement.js`** — same pattern: `reference = opts.reference || (journalId ? await getNextReference(...) : null)`. Pure passthrough/delegation, no assembly or parsing.

---

## 2. Numbering scheme: two options

### Option A — Per-journal numbering (recommended)

`reference = NNNNN` (e.g. `00001`), scoped by `(company_id, journal_id, year)` — **the exact same `journal_sequences` table and primary key that already exists today.**

- **Schema change:** none.
- **Code change:** delete the `journals` join and the `${code}/${year}/` prefix from the two mint functions. That's it.
- **Uniqueness:** *not* globally unique within a company-year — `MISC` and `BANK` can both mint `00001` in 2027. This is not a new property of the data (the counter was already independent per journal); it only becomes visible now that the code isn't printed alongside the number. Anywhere `reference` is shown or searched on its own now needs to carry `journal_id` (or the journal code/name) alongside it for disambiguation — see §3.2.
- **Precedent:** this matches the "multiple series" (`flera serier`) convention that's normal in Swedish bookkeeping and that SIE 4 itself supports natively (`#VER <series-letter> <number>`) — each journal is conceptually its own numbered series. freeBooks' `sie-export.js` doesn't currently map `journal → series letter` (it hardcodes series `A` for everything, see §3.4), but Option A keeps that door open as a future, low-risk enhancement rather than closing it off.

### Option B — Global numbering

`reference = {YEAR}-NNNNN` (e.g. `2027-00001`), one sequence per `(company_id, year)` shared across all journals.

- **Schema change:** required. `journal_sequences` is keyed by `journal_id`; a global counter needs either a new table (e.g. `company_sequences(company_id, year, last_seq)`) or a sentinel value hacked into the existing `journal_id NOT NULL` column, which is worse. A new table is the only clean option.
- **Code change:** `getNextReference`/`getNextReferenceBatch` would need a second code path (or a `journalId = null` meaning "use the global counter"), plus the new table wired into `db/init.js`/`schema.sql` migrations.
- **Behavior change:** postings across *different* journals now contend for the same counter row. At freeBooks' stated scale (small companies, single- or few-user, README "tens of lines per month" territory per the bank-matching spec's scale assumptions) this is not a real concurrency concern — but it is a bigger, less-precedented change for less benefit.
- **Benefit over A:** every reference is globally unique within a company-year without needing `journal_id` alongside it for disambiguation.

### Recommendation

**Option A.** Zero schema change, a two-function edit instead of a new table, no behavior change to the counters (only to what's printed), and it's the smaller, more reversible change. It also composes better with the existing DB design (`journal_sequences` was already built as per-journal) rather than fighting it. Option B's one real advantage — global uniqueness without needing the journal code alongside — is arguably not that valuable once you accept (per the issue's own premise) that `journal_id` is the authoritative disambiguator everywhere except the printed string.

This is a business-rule decision as much as a technical one (it affects what a human reads on a voucher), so per the project's existing decision-log convention (`Ratified 2026-08-02 (magnus)` comments in `journal.js`), it should be explicitly ratified before implementation, not just merged.

---

## 3. Detailed design (assuming Option A is ratified)

### 3.1 Minting — `journal.js`

```js
// getNextReference — after
async function getNextReference(companyId, journalId, year) {
  await exec(`INSERT INTO journal_sequences (company_id, journal_id, year, last_seq)
              VALUES (@companyId, @journalId, @year, 0) ON CONFLICT DO NOTHING`,
    { companyId, journalId, year });
  await exec(`UPDATE journal_sequences SET last_seq = last_seq + 1
              WHERE company_id = @companyId AND journal_id = @journalId AND year = @year`,
    { companyId, journalId, year });
  const rows = await query(
    `SELECT last_seq FROM journal_sequences
     WHERE company_id = @companyId AND journal_id = @journalId AND year = @year`,
    { companyId, journalId, year });
  if (rows.length === 0) throw new Error('Failed to generate reference');
  return String(rows[0].last_seq).padStart(5, '0');
}
```

`getNextReferenceBatch` gets the same treatment: drop the `journals` JOIN, return `String(startSeq + i).padStart(5, '0')` instead of the templated string. No other logic in either function changes (the atomic insert-then-increment pattern, the pre-allocation math) — this is purely deleting the prefix assembly.

Keep 5-digit zero-padding. Nothing about this refactor motivates changing it, and it preserves correct text-sort ordering up to 99,999 postings per journal per year, same as today.

### 3.2 Filtering — `journal.js` `listEntries` (`journal.list`), its live UI caller, and the action catalog

Today:
```js
if (journalCode) { sql += ` AND reference LIKE @jCodePfx`; params.jCodePfx = journalCode + '/%'; }
```

driven by a real, live, human-facing filter box in `reports/render.js`'s Journal Report page (`buildJournal`) — not a hypothetical caller:

```html
<label>Journal Code:</label>
<input type="text" id="f-journal" placeholder="e.g. BANK" maxlength="10" style="width: 120px;">
```
```js
function doSearch() {
  currentFilters = {
    dateFrom: '${start}', dateTo: '${end}',
    accountCode: document.getElementById('f-account').value.trim(),
    journalCode: document.getElementById('f-journal').value.trim()
  };
  loadJournal(); // → POST journal.list with { ...currentFilters }
}
```

**Design decision: code-input vs. ID-filter.** This has to be made explicitly, because the two ends of this param (the SQL filter and the UI box) must move together or the filter silently breaks (1.10). Two options:

- **(a) Keep the wire param as a human-typed code (`journalCode`), resolve it server-side.** No frontend change — `listEntries` resolves the typed code to a `journal_id` via a join/subquery against `journals`, then filters `journal_entries.journal_id` on that. Preserves today's free-text UX exactly.
- **(b) Move the boundary to `journal_id`, and make the UI ID-aware.** Rename the param to `journalId` everywhere (backend, catalog, UI), and change the free-text box in `render.js` into a journal-aware selector, the same way `journal-new.js` already does for its own journal dropdown: fetch `journals.list` once, populate a `<select>` with `value="journal_id"` / label `"CODE — Name"`, and send the selected `journal_id`.

**Decision: (b).** Reasons:
- It removes the last place in the codebase that filters journal entries by typing a free-text code instead of picking a real journal — every other journal-aware control (`journal-new.js`'s `#entry-journal` select) already works this way. (a) would leave `journal.list` as the sole exception, matched by string, and re-introduces the exact failure mode this whole refactor exists to remove: a typo (`BAN` vs `BANK`) or a case mismatch produces silent "no results" instead of an error, because there's still a string comparison sitting in front of the real FK.
- The precedent and the fetch pattern already exist verbatim in `journal-new.js` (`action: 'journals.list'` — note: the **plural** `journals.list`, the journal-master-list action, is a different action from the **singular** `journal.list` this section is about) and in `render.js` itself (the existing `accountsMap` pre-fetch pattern for the Account Code filter's sibling data). This is a small, precedented change, not a new pattern.
- It keeps the `journal.list` action's contract consistent with `journal_id`-based filtering everywhere else in this spec (§3.3's reversal fix does the same FK-not-string move).

Concretely:

```js
// journal.js — listEntries: exact FK filter, no string matching at all
if (journalId) { sql += ` AND journal_id = @journalId`; params.journalId = journalId; }
```

```html
<!-- render.js: replace the free-text box with a journal-aware select -->
<label>Journal:</label>
<select id="f-journal" style="width: 160px;"><option value="">— all —</option></select>
```
```js
// render.js: populate it the same way journal-new.js populates #entry-journal
fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({ action: 'journals.list', companyId: '${company}' }) })
  .then(r => r.json())
  .then(res => {
    var sel = document.getElementById('f-journal');
    (res.data || res || []).forEach(function (j) {
      var opt = document.createElement('option');
      opt.value = j.journal_id;
      opt.textContent = j.code + ' — ' + j.name;
      sel.appendChild(opt);
    });
  });

function doSearch() {
  currentFilters = {
    dateFrom: '${start}', dateTo: '${end}',
    accountCode: document.getElementById('f-account').value.trim(),
    journalId: document.getElementById('f-journal').value
  };
  loadJournal();
}
```

**`action-catalog.js` must change in the same commit**, or the introspectable schema (and what the MCP server hands agents as the tool's param list) goes stale the moment `journal.list`'s actual param is renamed:

```js
// action-catalog.js — journal.list params: rename to match
params: { dateFrom: { type: 'date' }, dateTo: { type: 'date' }, accountCode: { type: 'string' },
          source: { type: 'string' }, journalId: { type: 'string' }, billId: { type: 'string' },
          sortBy: { type: 'string' }, sortDir: { type: 'string' }, limit: { type: 'number' } },
```

Separately (not a rename, but a stale literal in the same file): `journal.post`'s `description` currently reads *"A sequential `{CODE}/{YYYY}/{NNNNN}` reference is always minted..."* — that literal format string needs to be corrected to describe the new format (e.g. *"A sequential doc-number reference, zero-padded and scoped per journal per year, is always minted..."*), since this description is agent-facing documentation, not a comment.

This whole filter-and-catalog change is a strict improvement independent of the reference-format change itself (matching on an actual FK instead of a string convention, with a real picker instead of free text), but it's now *mandatory* since the LIKE-prefix it currently relies on disappears. See §4.1 for why it's additionally gated on confirming `journal_id` backfill on historical rows before it ships — the same gate applies here as to any other `journal_id`-based filter.

### 3.3 Reversal journal pre-select — `journal-new.js` (the one real functional break)

Today (`applyReversalLines`):
```js
// Match journal by reference prefix
var code = ref && ref.includes('/') ? ref.split('/')[0] : '';
if (code) {
  var jSel = document.getElementById('entry-journal');
  var opt = Array.from(jSel.options).find(o => o.text.startsWith(code + ' '));
  if (opt) jSel.value = opt.value;
}
```

Once `reference` has no `/`, `code` is always `''` and the journal dropdown silently stops pre-selecting on reversal — a real regression, not just cosmetic, since it's the thing the issue names.

The fix is a strict improvement, not just a patch: `applyReversalLines(batchId, ref, lines)` is *always* called with `lines` freshly fetched from `journal.get` (`SELECT * FROM journal_entries WHERE batch_id = ...`), which already includes `journal_id` on every row — both call paths confirm this (`toggleViewReversalMode` uses `viewBatchLines` from `journal.get`; `loadReversalEntry` fetches `journal.get` itself before calling `applyReversalLines`). So instead of parsing an id out of a formatted string, use the id that was on the row the whole time:

```js
// Match journal via journal_id already present on the fetched row —
// no string-parsing, works for old- and new-format reference alike.
var jId = (lines[0] && lines[0].journal_id) || '';
if (jId) {
  var jSel = document.getElementById('entry-journal');
  jSel.value = jId;
}
```

`<select id="entry-journal">` options are already populated with `value="'+j.journal_id+'"` (confirmed in the `journals.list` load handler), so this is a direct assignment, no lookup needed. This also fixes reversal-pre-select for **any** historical row whose `journal_id` is populated but whose `reference` happens to be malformed or missing a `/` for some other reason — the old code was already fragile in that sense; this removes a class of bug, it doesn't just preserve current behavior.

### 3.4 SIE export — correcting the issue's stated assumption

The issue lists `sie-export.js` as "likely uses reference as verifikat number." Checked against `main` — it doesn't:

```js
// #VER numbering: a fresh per-export sequential counter, NOT derived from reference
ordered.forEach((b, i) => {
  L.push(`#VER A ${i + 1} ${ymd(b.date)} ${q(b.text)}`);
  ...
```

The `#VER` number is `i + 1`, a counter over vouchers in export order, hardcoded to series `A`. `reference` only appears earlier as a text fallback for the voucher's free-text field:

```js
COALESCE(reference, description, '') AS vtext
```

So **no functional change is needed in `sie-export.js`** for this refactor — `#VER` numbering is untouched either way. The only effect is cosmetic: for entries with no `description`, the exported voucher text becomes a bare `00001` instead of the more self-describing `MISC/2027/00001`. That's a minor loss of context in an audit artifact (the `.se` file a Skatteverket auditor might open), not a break. Two options, neither required by this spec:

- Accept it — the voucher's `date` and line-level `account_code`/amounts are still fully present; `reference` was never the primary identifying text.
- Improve it as a follow-up: join `journals.name` into the SIE query and fall back to `journal.name + ' ' + reference` (e.g. `Miscellaneous 00001`) instead of bare `reference`. Small, separable change; flagged here as a nice-to-have, not part of this spec's required scope.

### 3.5 Recommended UI follow-ups (not required, but worth doing alongside)

Two usability regressions fall directly out of removing the code prefix, both traceable to the same root cause — the code used to be visible "for free" inside `reference`, and now it isn't:

1. **`pages/journal.js` register**: the `reference` column now shows a bare number that's only unique *within its journal*. Recommend adding a `journal` (code or name) column to `groupBatches()`'s output (the row data already has `journal_id` via `SELECT *`; just needs the code/name looked up, e.g. via a small in-memory `journals.list` map like the one `journal-new.js` already builds) so two different `00001`s aren't visually indistinguishable.
2. **`journal.js` `searchEntries` (`journal.search`)**: the reversal search box's free-text search (`reference ILIKE @q OR description ILIKE @q OR ...`) currently lets a user type `MISC` or `2027` to narrow results by journal/year, because those substrings live inside `reference`. That capability quietly disappears once `reference` is just `00001`. If this UX is worth preserving, `searchEntries` would need a join to `journals` and an `OR j.code ILIKE @q` clause — a small, separable addition.

Neither blocks the core refactor; both are worth a line item in the ratification thread so the decision to defer them (or not) is explicit rather than accidental.

---

## 4. Migration

### 4.1 Existing `reference` values

Per the issue's own framing: leave historical `reference` values as-is, mixed-format. Do not rewrite them. Reasons:
- Any external artifact that already cites the old-format reference (a printed voucher, an email to a vendor, a prior SIE export, an auditor's workpaper) stays valid.
- Rewriting historical data for a purely cosmetic refactor is unnecessary risk for no accounting benefit — the ledger's integrity checks (per `docs`, the `integrity` report / RE roll-forward) don't depend on `reference`'s shape.

New postings get the new format from the deploy of this change onward; no dual-write or transition period is needed, since minting is atomic per-post and the format is a pure string-assembly choice with no downstream constraint (no uniqueness index on `reference` itself was found in `schema.sql`).

### 4.2 Blocking question: is `journal_id` backfilled on historical rows?

`schema.sql` adds the column as:
```sql
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS journal_id VARCHAR;
```
which, on its own, leaves `journal_id` `NULL` on every row that existed before this migration ran, unless a separate backfill step (part of the opening-balance work, not visible on `main` at the time of writing) already populated it.

This matters directly for §3.2: if `listEntries`'s new `journal_id = @journalId` filter goes live while historical rows still have `journal_id IS NULL`, then filtering the journal register by journal silently **drops every pre-migration entry** from the view — a real regression, not a cosmetic one.

**This needs to be verified before implementing §3.2**, not assumed. If a backfill hasn't happened, one is straightforward for exactly the well-formed `CODE/YEAR/NNNNN` rows (the only kind that existed before this change):

```sql
UPDATE journal_entries e
SET journal_id = (
  SELECT j.journal_id FROM journals j
  WHERE j.company_id = e.company_id
    AND j.code = split_part(e.reference, '/', 1)
)
WHERE e.journal_id IS NULL
  AND e.reference LIKE '%/%/%';
```
(Same idempotent, `IF NOT EXISTS`/backfill-on-run style already used elsewhere in `schema.sql`'s inline migrations.) Rows with no `reference` at all (the pre-2026-08-02 null-reference era, per the `resolveDefaultJournalId` doctrine comment in `journal.js`) can't be backfilled this way and would stay `journal_id IS NULL` — acceptable, since those are journal-less by original design, not a product of this refactor.

---

## 5. Testing checklist

- Unit test: `getNextReference` returns `00001`, `00002`, ... (no prefix), still scoped correctly per `(company_id, journal_id, year)` — i.e. two journals in the same year both start at `00001` independently, and the same journal rolls over to `00001` in a new year.
- Unit test: `getNextReferenceBatch` pre-allocation math unchanged, only the returned strings' format changes.
- Regression: `journal_sequences` row count/values identical before and after for a given posting sequence — this change touches only string assembly, never the counter logic.
- `journal.list` (`journalId` filter): returns correct rows for a journal with only post-migration entries, and — pending §4.2's answer — either also returns backfilled historical entries, or a documented decision that it intentionally doesn't.
- `reports/render.js` Journal Report filter: the new `#f-journal` select populates from `journals.list` (plural action) and correctly filters via `journal.list`'s (singular action) `journalId` param end-to-end — this is the regression most likely to slip through if §3.2's two halves (backend param rename + frontend control swap) are implemented in separate commits.
- `action-catalog.js`: `GET /api/actions` reflects `journalId` (not `journalCode`) for `journal.list`, and `journal.post`'s description no longer contains the literal `{CODE}/{YYYY}/{NNNNN}` string.
- Reversal flow, both entry paths (reversal-search-box pick, and toggle-from-view-mode pick): journal dropdown correctly pre-selects for (a) a new-format entry, (b) an old-format entry whose `journal_id` is populated, (c) confirm no crash/silent-no-op for an old-format entry with `journal_id IS NULL` (should simply leave the dropdown at its default — same as today's `code` ending up `''`).
- SIE export golden test (byte-for-byte fixture, per the README's mention of one) should still pass unchanged, since `#VER` numbering doesn't depend on `reference` (§3.4) — confirms the issue's assumption was corrected, not just documented.

---

## 6. Open questions for ratification

1. **Confirm Option A vs B.** This spec recommends A (no schema change, matches existing per-journal-per-year counter design, aligns with SIE multi-series convention). Needs an explicit ratification, same as the 2026-08-02 reference-doctrine decision already recorded in `journal.js`.
2. **Is `journal_id` backfilled on historical `journal_entries` rows already**, as part of whatever landed the column, or does §4.2's backfill migration still need writing? Blocks §3.2 either way until answered — and §3.2 now spans three files (`journal.js`, `reports/render.js`, `action-catalog.js`) that must land together, so this is worth confirming before that work starts, not discovered mid-PR.
3. **Do we add the "Journal" column to the register (§3.5.1)** to replace the visual information the code prefix used to carry, or accept that the journal register now requires unfolding/hovering a row to know which journal posted it?
4. **Do we restore journal-code search in the reversal search box (§3.5.2)**, or accept that as a minor, documented UX regression?
5. **Padding width** — keep 5 digits (`00001`)? Nothing in this refactor motivates a change; flagging only so it's an explicit rather than default choice.
