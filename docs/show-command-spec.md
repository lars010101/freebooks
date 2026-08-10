# `:show` / `:report` Command Spec

**Status:** Draft v6 — review comments resolved, ready to build modulo the two items in §10.
**Scope:** the command-bar interaction model — bare `:`, `:show`, `:report`, and by extension `:bill`.
**Supersedes:** v4 (see §1).
**Depends on:** `action-catalog.js`, `report-registry.js`, `fb-core.js`'s palette component (`_catalog`, `_match`, `_render`, `_detectGrammar`, `_showGrammarHint`), `common.css` (`.fb-palette`, `.fb-grammar-hint`).

---

## 0. Why this exists

Unchanged from v3/v4: neither `?`'s NAV section nor the pre-#149 `:` palette reach tab-level destinations. `:show` closes that gap.

---

## 1. What changed from v4, and why

v4 generalized three special cases (`:show`, `:report`, `:bill`) into one mechanism — correct move, kept. Review of v4 found three things that were stated more confidently than they should have been, and one clean simplification that was missed:

1. **The `new=1` route-string sniff was load-bearing infrastructure disguised as a leftover.** Promoted to an explicit field.
2. **"Bare `:` after typing" and "`:show` owns navigate entries" were contradictory as written** — the spec claimed `_match()` was "unchanged" while also claiming navigate entries never appear at bare `:`, even typed. Those can't both be true unless the *candidate list* `_match()` runs against changes, which the spec didn't say. Fixed by unifying the candidate list bare-`:` uses regardless of query state (§2).
3. **The ghost-text overlay was flagged as blocking, then a proposal to defer it turned out not to be free** — checked the actual CSS: `.fb-grammar-hint` and `.fb-palette` are positioned identically (`position:absolute; top:calc(100% + 4px); left:0`) and have never had to coexist before. Once hint+dropdown render together, they overlap. §8 now specifies the smaller fix that actually unblocks the critical path.
4. **`:report`'s type/period boundary has a clean, total answer:** report ids are always single whitespace-delimited tokens (verified against the full id list — `ap-aging`, `voucher-register`, etc. are hyphenated but contain no internal whitespace), so "first token = type, everything after the first space = period" has no edge cases to break on. This resolves what v3 and v4 both left open — but only for `:report`. It does not generalize to `:bill`'s partner slot, where names are multi-word (§7 splits these explicitly rather than let one rule quietly cover both).

---

## 2. Bare `:` — one candidate list, two renderings of it

**v4's error:** treated "collapsed at empty query" and "flat `_match()` at non-empty query" as two different code paths with two different (implicit) candidate sets, which is what let navigate entries sneak back in once typing started. **Fix:** one candidate-list function, used by both states.

```js
function _verbCandidates() {
  return _aliasCommands().concat(_apiCommands()).filter(function (c) {
    if (c.scope !== 'api') return true;   // aliases always included
    if (!_isNavigate(c)) return true;     // execute actions always included
    return c.create === true;             // navigate entries only if they're create-shortcuts
  });
}

function _defaultItems() {
  var q = _query();
  if (q !== '') return _match(q, _verbCandidates());  // same restricted list, just not collapsed
  if (_newExpanded) return _verbCandidates().filter(function (c) { return c.create; });
  var out = [], seenNew = false;
  _verbCandidates().forEach(function (c) {
    if (c.create) { if (!seenNew) { out.push(_newGroupRow()); seenNew = true; } return; }
    out.push(c);
  });
  return out;
}
```

`_match()` itself is genuinely unchanged — it's a generic scorer. What changed, correcting v4's claim, is that it's now always called against `_verbCandidates()` rather than the unrestricted catalog. Navigate-non-`create` entries (routes/tabs) are excluded from bare `:` in every state — empty, expanded, or typed — because they're excluded from the one list every state draws from. No separate "narrowing" claim to keep consistent across two code paths anymore; there's only one.

### 2.1 `create` — an explicit catalog field, not a route sniff

Add `create: true` to every catalog entry currently identified only by `new=1` in its route. The route can keep the query param (it still needs to reach the destination page's auto-activate behavior) — the field is what the palette reads, so a future edit to the route string can't silently break §2's filtering. Comment the field's purpose at the catalog schema, not just at each use site.

### 2.2 "New…" expansion and exit

Clicking the collapsed "New…" row sets `_newExpanded = true` and re-renders — no text is typed into the input, since there's no `:new` alias to invoke. Two ways out, both explicit:

- **Type anything** — `q !== ''` takes over per §2's branch regardless of `_newExpanded`, so typing is always an implicit exit.
- **Backspace at empty query** — otherwise a no-op keystroke in this state — clears `_newExpanded` and returns to the collapsed default. This is the explicit "I didn't mean to click that" path the review correctly flagged as missing.
- **Escape from expanded** — clears `_newExpanded` and returns to the collapsed default, *staying in command mode*. Escape only exits command mode from the collapsed state. This matches the "Escape = back one level" convention: expanded → collapsed → exit. One Escape never jumps two levels.

`_newExpanded` resets to `false` whenever command mode exits (blur, successful navigation) — it's UI-only state, never persisted.

---

## 3. The generalized mechanism: decoupled hint + open dropdown

Unchanged from v4 in structure — splitting `_showGrammarHint` into an independent `_renderHint()` and `_renderItems()`, with a per-alias, per-slot `itemSource` (§4). What changed is *where* the hint renders (§8) and how granular slot detection needs to be (§7).

```js
'show':   { grammar: '<target>',                        itemSource: [showTargets] },
'report': { grammar: '<type> [period]',                  itemSource: [reportTypes, null] },
'bill':   { grammar: '<partner> <amount> [date] [ref]',  itemSource: [partnerMatches, null, null, null] },
```

---

## 4. `:show` — routes and tabs only

Unchanged from v4. `showTargets()` filters `_catalog` to `palette === 'navigate'`, `create` falsy, route not starting with `/reports`.

### 4.1 The gap

| New entry | Route |
|---|---|
| `vat.codes.view` | `/settings?tab=vat` |
| `journals.view` | `/settings?tab=journals` |
| `ai.view` | `/settings?tab=ai` |
| `openingBalance.view` *(no backing action — still an open decision, §10)* | `/settings?tab=opening-balances` |

### 4.2 Reports collapse to one row

`/reports`, no expansion — this is what keeps `:show` from ever needing a type/period boundary rule in the first place.

### 4.3 Grouping — still optional

~11 rows once reports collapse to one. Route-prefix grouping is cheap if wanted, not required for usability at this size.

---

## 5. `:report <type> [period]`

- `reportTypes()` sources from `GET /api/:company/reports/registry` (id+label, generated from `REPORT_REGISTRY`).
- `:report ` alone → dropdown lists every report by label, hint shows `<type> [period]`.
- Selecting a row navigates immediately, no period — reports hub's picker takes over from there.

### 5.1 The type/period boundary — resolved

**First whitespace-delimited token is always the type; everything after the first space is the period.** No heuristic needed:

```
:report pl        → type filter "pl" (or exact match), no period, dropdown still open if ambiguous
:report pl q2     → type "pl" resolved (exact or best fuzzy match), period "q2"
:report p         → type filter "p", ambiguous (matches pl, ap-aging, ap-control...) — keep filtering
```

Total, not heuristic, because every report id in the registry is a single token (hyphens, no internal whitespace — checked against the full list: `pl`, `bs`, `cf`, `sce`, `tb`, `gl`, `journal`, `integrity`, `ap-aging`, `ap-control`, `ar`, `sie`, `voucher-register`). The first token doesn't need to be an exact id match at commit time either — resolve it the same way the dropdown already fuzzy-matches (`vou` → `voucher-register`) before treating the rest as the period. The period stays a thin, unvalidated pass-through (`&period=<raw>`), resolved by `reports-hub.js`, unchanged from v3/v4.

### 5.2 Ambiguous type at commit time

If the first token matches multiple report ids at Enter (e.g., `:report p q2` — "p" matches `pl`, `ap-aging`, `ap-control`, ...), resolve to the **best fuzzy match** and navigate immediately, preserving the period. No "ambiguous, refuse to commit" dead-end — the user typed a period, so they're done selecting. This is the same best-match behavior the dropdown already applies on Enter for unique-but-imperfect matches; the only difference is the period is carried along. If the best match is wrong, the user sees the wrong report and corrects the type token — same recovery loop as any other typo.

---

## 6. `:bill` (and the pattern generalizing further)

Unchanged in intent from v4: `partnerMatches(partial)` reuses the existing partner-master data journal entry already loads. Slot 0 dropdown-enumerable, slots 1+ free text with no item source.

---

## 7. Slot detection — scoped by candidate shape, not one general solution

v4 called this "slightly extended" tokenizing; review correctly called that an understatement for the general case (arbitrary cursor position, mid-token edits, trailing-space edge cases). Splitting by alias avoids needing the general solution at all right now:

- **`:report`** — §5.1's rule is total for this alias: token count only, no cursor-position mapping needed, because the boundary is always "first space." A user typing left-to-right never needs mid-string edit support here to get correct behavior.
- **`:bill`** — partner names are multi-word, so there's no clean token-boundary rule. Resolution: **advance-on-selection**, not advance-on-space. Picking a partner row (click or Enter-on-highlighted) commits slot 0 and moves to slot 1 (`<amount>`), regardless of how many space-delimited words the partner name contained. On commit, the partner's **display label** (full name, e.g., "ACME Corp") is placed into the input — not the internal id/key — so the command string stays human-readable as the user's mental model of what they typed. A user who types a full partner name blind without ever selecting from the dropdown needs a different commit signal (e.g., the next recognizable token boundary is "an amount-shaped token appears") — not fully specified here; flagged in §10 rather than guessed at.
- **General cursor-position slot detection** (mid-token edits, arbitrary repositioning) is out of scope for v1 entirely — not needed by either alias above, and not worth building ahead of a concrete need.

---

## 8. Hint placement — fold into the dropdown panel, defer true ghost-text

**Checked, not assumed:** `.fb-grammar-hint` and `.fb-palette` are positioned identically in `common.css` (`position:absolute; top:calc(100% + 4px); left:0`). They've never needed to render simultaneously before, so the collision was latent, not visible. §3 makes them coexist, so it's no longer latent.

**v5 fix (in scope now):** render the hint as a sticky header row inside the *same* `.fb-palette` panel — one floating element, not two. `_grammarEl` goes away as a separate DOM node; `_renderItems()` prepends a non-selectable header row when a hint is active. `_activeIdx` indexes the items array, not DOM rows, so the header row adds no offset — arrow movement skips it automatically.

**Deferred (not in scope now):** true inline ghost-text inside the input box itself (text overlaid behind/after what's typed, greyed remainder of the grammar). That's the nicer version of what was asked for originally, but it's a self-contained visual upgrade on top of the header-row version above, not a prerequisite for the mechanism to work. Building the header-row version first means `:show`/`:report`/`:bill` aren't blocked on it.

---

## 9. Migration checklist

- `action-catalog.js`: add `create: true` to existing `new=1` entries (§2.1); add the four entries in §4.1.
- `_verbCandidates()` (§2) replacing the ad-hoc filtering v4 had split across two branches.
- `_newGroupRow()` / `_newExpanded` state + Backspace-at-empty-query exit (§2.2).
- Split `_showGrammarHint` into `_renderHint`/`_renderItems`; fold hint into `.fb-palette` as a header row (§8) — no new `.fb-grammar-hint` element.
- `itemSource` per alias (§3): `showTargets`, `reportTypes`, `partnerMatches`.
- `GET /api/:company/reports/registry`.
- `:report`'s token-count slot detection (§5.1/§7) — no cursor-position mapping needed.
- `:bill`'s advance-on-selection commit for slot 0 (§7) — the blind-typed-partner-name case stays open, see §10.
- Tests:
  - bare `:` at empty query: collapsed, "New…" present once, no navigate-non-create entries.
  - bare `:` while typing: same candidate list, no navigate-non-create entries appear (regression guard for the v4 contradiction).
  - "New…" click → expand → Backspace → back to collapsed, with no text ever in the input.
  - "New…" click → expand → type a character → behaves as ordinary typed search (implicit exit).
  - `:show` never contains a `create` or `/reports/...` entry.
  - `:report pl q2` → type "pl", period "q2"; `:report p` → still filtering, no period.
  - `:report p q2` → ambiguous type + period → best fuzzy match, period preserved, navigates.
  - hint + dropdown render together with no visual overlap (header-row layout).
  - arrow-key regression guard (§ prior round's bug) — content stays fixed, only highlight moves.
  - arrow keys skip the hint header row (don't land on it, don't count it in movement).

---

## 10. Explicitly open

- `:bill`'s blind-typed (no dropdown interaction) partner-name commit signal — advance-on-selection is specified, advance-on-blind-typing is not (§7).
- `openingBalance.view` synthetic-entry-vs-real-action decision (carried from v3/v4, still undecided).
- True inline ghost-text-in-input (§8) — deferred, not designed further here.
