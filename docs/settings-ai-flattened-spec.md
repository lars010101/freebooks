# Settings/AI Tab — Flattened Spec

## Goal
Flatten Settings → AI from three grouped sections of discrete fields into a single Attribute/Value/Type list, following the pattern already established on Settings → Company.

## Pattern (established by Company tab)
- Three columns: **Attribute**, **Value**, **Type**.
- `Type` drives which widget renders in Value when editing (String, Number, Boolean, Choice, etc.).
- Each row edits and saves **independently** — click into Value, get an inline editable widget, confirm (✓) or cancel (✗). No page-level "Save" button.
- The tab label carries a dirty-state indicator (dot) when an unsaved edit exists anywhere on the tab — this is tab-level, not per-row.

Applied to AI, this replaces "Save AI settings" entirely — every field commits the same way Company's Reporting Standard does.

## Row list

| Attribute | Value | Type |
|---|---|---|
| Enable agent pipeline | No | Boolean |
| Poll interval (ms) | 30000 | Number |
| Inbox path | ~/freebooks-inbox | String |
| LLM endpoint URL | — | String |
| LLM API key | — | String |
| LLM model | — | String |
| LLM temperature | 0.1 | Number |
| Vision endpoint URL | — | String |
| Vision model | — | String |
| Vision API key | — | String |

API keys typed as plain `String`, matching Company's existing FX API Key — no masking.

## Test connection — action handling
Doesn't fit the edit → confirm/cancel shape of the other rows: there's no value to hold or commit, just an action to trigger. Recommend a dedicated `Action` Type — the Value cell renders a button; clicking it fires the test directly, with no ✓/✗ affordance since nothing is being saved. Keeps the action inside the list rather than pulling a lone button out below the grid.

| Attribute | Value | Type |
|---|---|---|
| Test LLM connection | [Test connection] | Action |

## Agent status
Currently a read-only "Loading…" field inside the Agent pipeline group. This is live operational state, not a setting, so it drops out of the list entirely rather than becoming a row. Suggest surfacing it wherever other pipeline/job health lives (a dashboard, or a status indicator near the inbox/agent feature itself) instead of on this config screen.

## Deferred (explicitly out of scope for this pass)
- **Group context** — the section headers and their explanatory sentences ("automatic processing of bank statements...", "leave blank to disable image extraction") are dropped for now, to return later as a per-row help-text mechanism.
- **Format/placeholder hints** (e.g. `qwen2.5-7b-instruct`, `http://127.0.0.1:8080 or https://api.openai.com`) — same treatment, deferred to help text.
- **Secret masking** on API key fields — skipped by decision; treated as plain String.

## Open questions
1. Is adding `Action` as a new Type acceptable? Company's tab only demonstrates String/Choice/Boolean/Number so far — this would be a new addition to the Type vocabulary, worth confirming it's a welcome extension rather than a one-off.
2. Where does Agent status surface once it's off this tab?
