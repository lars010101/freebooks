# FX Rate Automation — spec (agreed 2026-07-23; groundwork shipped 2026-07-27, automation core shipped this PR)

Replaces manual `f` / 📡 Fetch Rates with automatic, coverage-driven rate management.
Design agreed with Magnus 2026-07-23. **Status 2026-07-27: groundwork shipped (PRs #46/#47) — build-order item 2 ✅: `fx_tracking` setting + per-company provider/`manual`/API-key rows on the Company attribute grid, install-level config adopted per-company on first read, relevance gating live (Exchange Rates tab hidden + currency fields locked to base when `'off'`). Automation core NOT built (items 1, 3–5: `fx.coverage` + `fetchRange`, Periods status column, notifications, scanner) — do not build until scheduled.**

**Revision 2026-07-27 (ratified, Magnus, Slack Settings thread):**
1. **Provider config is install-level, not per-company.** One provider + API key for the whole installation: the rate table is global, so per-company providers only produced duplicate fetches and last-writer-wins on shared rows. Provider UI is a read-first panel with explicit Save on the **Exchange Rates tab** (placement rev. 2, 2026-07-27: no admin page is built — deferred until install-level surface area accumulates. ✅ Tracked — GitHub issue). Revises §1, §6.
2. **`fx_tracking` blast radius expanded.** `'off'` additionally means simplified UI for domestic-only companies: Exchange Rates tab hidden, currency fields on bills/journals locked to base currency, FX revaluation actions hidden. Revises §1.
3. **Zero-company short-circuit.** If no company has `fx_tracking = 'auto'`, nothing is downloaded and no gap scanning runs at all. Revises §6.

**Revision 2026-07-27 (rev. 3, ratified, Magnus, same thread — supersedes rev. 1 above):**
1. **Provider config is PER-COMPANY after all.** `fx_provider` + `fx_provider_api_key` are per-company settings rows on the Company tab's attribute grid (settings-ux-spec §7 item 1 rev. 3); the install-level (`__install__`) era is dropped, with existing install config adopted per-company on first read. Duplicate-fetch / last-writer-wins on the global rate table is accepted: fetches are idempotent per date+source (delete-then-insert), and in practice one installation runs one provider per company.
2. **`manual` is a first-class provider choice.** `fx_provider = 'manual'` (the default) = no automatic download — fetch verbs, period hooks, and the scanner skip the company; hand-entered rates (`source='manual'`) still satisfy coverage. The old tri-state collapses: **Multi-Currency boolean** (`fx_tracking` auto/off) governs UI visibility; the provider choice governs automation. Old mapping: `off` → multi-currency No; `manual` behavior → multi-currency Yes + provider `manual`; `auto` → multi-currency Yes + a real provider.
3. **Scanner scope (revises §6):** per company, automation runs iff `fx_tracking = 'auto'` AND `fx_provider` is a real provider (not `manual`). Zero qualifying companies → short-circuit unchanged.

## 1. Company opt-out: `fx_tracking`

- New per-company setting `fx_tracking`: `'auto'` (default) | `'off'` (domestic-only company).
- UI: **Multi-Currency** Boolean row on the **Company tab** attribute grid (rev. 3). The provider config sits two rows below it in the same grid — per-company (rev. 3), with `manual` as a first-class choice.
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
- **Per-company (rev. 3, supersedes the install-level rev):** the scanner iterates companies; a company is automated iff `fx_tracking = 'auto'` AND its provider is a real one (not `manual`). Shared-table last-writer-wins is accepted (fetches are idempotent per date+source).
- **Short-circuit (rev. 2026-07-27):** if zero companies qualify, the scanner does nothing — no downloads, no coverage computation, no notifications.
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

1. ✅ **DONE (this PR):** `fetchRange` (ECB + OXR) + `fx.coverage` + `fx-coverage` module (diff logic against provider publication days).
2. ✅ **DONE 2026-07-27 (PRs #46/#47):** `fx_tracking` setting + per-company provider config as rows on the Company attribute grid (rev. 3; supersedes the install-level Exchange Rates panel); Period hook (§4) gated on provider ≠ `manual`.
3. ✅ **DONE (this PR):** Periods FX status column (§5) — async decoration, never blocks list render.
4. ✅ **DONE (this PR):** Notifications table + actions + bell UI (§7).
5. ✅ **DONE (this PR):** Scanner (§6) wiring 2–4 together; dedupe rule; scan-cadence env var (`FREEBOOKS_FX_SCAN_MS`).
