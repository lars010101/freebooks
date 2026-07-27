# FX Rate Automation — spec (agreed 2026-07-23, NOT BUILT YET)

Replaces manual `f` / 📡 Fetch Rates with automatic, coverage-driven rate management.
Design agreed with Magnus 2026-07-23. **Status: spec only — do not build until scheduled.**

**Revision 2026-07-27 (ratified, Magnus, Slack Settings thread):**
1. **Provider config is install-level, not per-company.** One provider + API key for the whole installation: the rate table is global, so per-company providers only produced duplicate fetches and last-writer-wins on shared rows. Provider UI moves from the Company tab to the admin page (explicit Save button). Revises §1, §6.
2. **`fx_tracking` blast radius expanded.** `'off'` additionally means simplified UI for domestic-only companies: Exchange Rates tab hidden, currency fields on bills/journals locked to base currency, FX revaluation actions hidden. Revises §1.
3. **Zero-company short-circuit.** If no company has `fx_tracking = 'auto'`, nothing is downloaded and no gap scanning runs at all. Revises §6.

## 1. Company opt-out: `fx_tracking`

- New per-company setting `fx_tracking`: `'auto'` (default) | `'off'` (domestic-only company).
- UI: checkbox on the **Company tab** ("Track FX rates for this company"). The provider config that used to sit next to it is install-level and lives on the admin page (rev. 2026-07-27).
- `'off'` disables everything below: no fetch verb, no status column, no scanning, no notifications.
- **Simplified UI (rev. 2026-07-27):** `'off'` also hides multi-currency surface area app-wide — Exchange Rates tab hidden, currency fields on bills/journals locked to the base currency, FX revaluation actions hidden. Companies with no FX exposure see a single-currency app. The flag is reversible (visibility/relevance, not an accounting lock).

## 2. Provider interface: `fetchRange` (new, optional)

```js
async fetchRange(baseCurrency, startDate, endDate, apiKey) → [{ date, from_currency, to_currency, rate, source, fetched_at }]
```

- ECB implements it via frankfurter's range endpoint (`GET /{start}..{end}?from={base}`) — **one call per period** returns every published day; also the efficient backfill mechanism.
- Providers without `fetchRange` fall back to a per-day `fetchRates` loop.
- Range data doubles as the **publication calendar**: the dates a provider actually published for a range are the ground truth for coverage (§3).

## 3. Coverage semantics — the core rule

**Coverage = stored days vs the provider's actual publication days** — never vs naive weekdays.
Weekends and ECB/TARGET holidays have no publication, so they never count as missing. A weekday-count
heuristic would false-flag red ~10 times a year; comparing against what the source published cannot.

- `fx.coverage` (new read action): per period `[start, min(end, today)]`, fetch the provider's
  publication days for the base currency, diff against stored `fx_rates` dates (any source counts as covered).
- Result per period: `{ status: 'na' | 'red' | 'green', missing: [dates] }`.
  - `na` — tracking off, no provider configured, or period entirely in the future.
  - `red` — `missing.length > 0`. `green` — complete.

## 4. Period hook — auto-download on period create

- `period.upsert` (server-side): after creating a period, if `fx_tracking = 'auto'` and a provider is
  configured, asynchronously backfill `[start, min(end, today)]` via `fetchRange` (insert missing days only).
  Fire-and-forget: the upsert response never waits on the provider.

## 5. FX status column on the Periods register

- New read-only column (right side): FX status flag — `—` (na), red dot (missing days), green dot (complete).
- Title/tooltip on red: "Missing N days (first: YYYY-MM-DD)". Data from `fx.coverage`, loaded after the
  register renders (async decoration, never blocks the list).

## 6. Gap scanner

- Server job: on startup + every **6 h** (env-tunable `FREEBOOKS_FX_SCAN_MS`).
- **Install-level (rev. 2026-07-27):** the scanner runs against the single installation-wide provider configuration. There is no per-company provider arbitration — the shared rate table cannot suffer cross-company last-writer-wins.
- **Short-circuit (rev. 2026-07-27):** if zero companies have `fx_tracking = 'auto'`, the scanner does nothing — no downloads, no coverage computation, no notifications.
- For each company with tracking on, for each period intersecting `[company start, today]`:
  compute coverage → fetch missing ranges → recompute.
- Still missing after the fetch attempt (provider down, currency unavailable, historical gap) →
  raise a notification (§7).

## 7. Notifications (new minimal subsystem — the 🔔 gets a backend)

The topbar bell is currently chrome-only. v1:

- Table `notifications`: `id, company_id, created_at, kind, message, read_at NULL`.
- Actions: `notifications.list` (unread first), `notifications.mark_read` (ids or all).
- UI: bell shows unread-count badge; click opens a dropdown list (read-first); clicking a row marks read.
- **Dedupe:** one open notification per issue key (e.g. `fx-gap:<company>:<period>`) — re-raise only after
  the previous one was read AND the issue persists on the next scan.
- Built once, reusable: future alerts (locked-period posts, failed imports) write to the same table.

## 8. What stays manual

- `f` / 📡 Fetch Rates verb remains as an on-demand refresh of the current day (list-level action,
  fb-list-ux-spec §8) — automation does not remove the manual override.
- Editing rates by hand still flips `source` to `'manual'`; manual rows satisfy coverage.

## Build order when scheduled

1. `fetchRange` (ECB) + `fx.coverage` + unit tests on the diff logic.
2. `fx_tracking` setting + Company-tab checkbox; install-level provider config on the admin page (relocated from the Company tab; storage: installation-scoped setting); Period hook (§4).
3. Periods FX status column (§5).
4. Notifications table + actions + bell UI (§7).
5. Scanner (§6) wiring 2–4 together; dedupe rule; scan-cadence env var.
