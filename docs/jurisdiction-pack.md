# freebooks — Jurisdiction Pack Spec

**Date:** 2026-07-29 · **Status:** RATIFIED (magnus, Slack thread 2026-07-29) · **Supersedes:** nothing; extends `reports-dashboard-spec.md` §5/§6 and roadmap §0m item 5

**Amended 2026-07-30 (magnus):** SE årsredovisning production + submission removed from scope — Gredor (open source, free, SIE-driven) owns it. §4 annual-report descriptors and §7 migration items 4–5 are **descoped**; the SE integration contract is the SIE 4 export (`report?type=sie`, must keep the 8999 `#RES` line for Gredor). The SRU/INK2 path (§§1–3, §7 items 1–3) remains fully in scope — Gredor does not do tax returns.

---

## 0. Purpose

freebooks serves multiple jurisdictions without per-country application code. Every country-specific concern lives in a **jurisdiction pack** — a directory of declarative files under `db/jurisdictions/<CC>/`. Adding a country means adding a directory; the app discovers it by scan (the `fxProviders/` and `report-registry.js` precedent: directory-scanned registries, no central switch).

**Data-first, code as escape hatch.** Account-mappable filings and statutory reports are pure data. New *file-format families* (XBRL, XML) or conditional business logic that isn't field arithmetic land as small shared modules behind the same registry — a contributor adding a country whose format is already supported writes **zero** application code.

## 1. Pack layout

```
db/jurisdictions/
  SE/
    coa.json                  # chart of accounts (existing)
    vat_codes.json            # tax codes (existing)
    jurisdiction.json         # manifest (this spec)
    filings/
      ink2.json               # income-tax filing descriptor (was sru_ink2.json)
      annual-report.json      # K2/K3 statutory report descriptor — DESCOPED 2026-07-30 (Gredor owns SE AR)
  SG/
    coa.json
    vat_codes.json
    jurisdiction.json
    filings/
      annual-report.json      # DESCOPED 2026-07-30 (no live need; SE precedent is Gredor)
```

`setup.init` and the company-creation flow already scan `JURISDICTIONS_DIR`; the scan is extended to load + validate the manifest and descriptors (§6).

## 2. `jurisdiction.json` — the manifest

```json
{
  "schema": 1,
  "code": "SE",
  "name": "Sweden",
  "currency": "SEK",
  "reportingStandards": ["K2", "K3"],
  "defaultReportingStandard": "K2",
  "taxIdFormat": "^\\d{6}-\\d{4}$",
  "taxIdSruPrefix": "16",
  "taxAttributes": [
    { "key": "loss_cf", "label": "Outnyttjat underskott", "type": "amount",
      "perYear": true, "rollforward": "closing_to_opening", "default": 0 },
    { "key": "audited", "label": "Årsredovisningen har varit föremål för revision", "type": "bool",
      "perYear": true, "default": false },
    { "key": "consultant", "label": "Uppdragstagare har biträtt vid årsredovisningen", "type": "bool",
      "perYear": true, "default": false }
  ],
  "contactAttributes": [
    { "key": "address", "label": "Adress" },
    { "key": "postnr", "label": "Postnummer" },
    { "key": "postort", "label": "Postort" },
    { "key": "contact_name", "label": "Kontaktperson" },
    { "key": "contact_phone", "label": "Telefon" },
    { "key": "contact_email", "label": "E-post" }
  ]
}
```

**`taxAttributes`** declares the per-fiscal-year tax facts the books cannot derive (carryforwards, flags). They are stored in **one JSON column** `periods.tax_attrs` keyed by attribute key — a new country's attributes need no schema migration. The Periods settings grid renders columns from the descriptor (FB.list; `amount`/`bool`/`text` editors); company-level defaults live in `company.attr` (`tax.<key>`), the period row overrides.

`rollforward: "closing_to_opening"` marks a carryforward: the filing engine computes the year's closing value and **proposes** it as next year's opening (warning until the prior year is `tax_filed_at`-stamped; the *filed* artifact is the audit chain — the opening always traces to what the authority received, not to a recomputation).

## 3. Filing descriptors (`filings/*.json`)

One file per authority filing. Example — `SE/filings/ink2.json` (shape):

```json
{
  "schema": 1,
  "id": "ink2",
  "name": "Inkomstdeklaration 2 (SRU)",
  "authority": "Skatteverket",
  "emitter": "sruLines",
  "route": "/api/:company/sru/ink2",
  "version": "{year}P4",
  "blanketts": ["INK2", "INK2R", "INK2S"],
  "fields": {
    "7261": { "blankett": "INK2R", "accounts": ["1630", "1680"], "kind": "asset" },
    "7302": { "blankett": "INK2R", "accounts": ["2091", "2098", "2099"], "kind": "equity" },
    "7417": { "accounts": ["8310", "8314"], "kind": "income" },
    "7550": { "op": "sign_split_loss", "source": "book_result" },
    "7450": { "op": "sign_split_profit", "source": "book_result" },
    "7754": { "accounts": ["8314"], "kind": "income" },
    "7763": { "op": "tax_attr", "attr": "loss_cf" },
    "7770": { "op": "loss_closing" },
    "7114": { "op": "copy", "source": "7770" },
    "7104": { "op": "copy", "source": "7670" },
    "8041": { "op": "flag", "attr": "consultant", "emitWhen": false, "value": "X" },
    "8045": { "op": "flag", "attr": "audited", "emitWhen": false, "value": "X" }
  }
}
```

As built 2026-08-01: each field carries `blankett` (engine stays emitter-agnostic); `tax_attr` resolution = query-param override → `periods.tax_attrs` → warning+0; `emitZero:true` forces emission of 0 (7763); 7011/7012 engine-injected per blanket.

**Kinds (computed by the engine):** `asset` (DR−CR at period end), `equity`/`liability` (CR−DR at end), `cost` (DR−CR within period), `income` (CR−DR within period). Whole-unit rounding, half-up on absolute value; zero/absent fields omitted unless the descriptor says otherwise.

**Ops (closed vocabulary — never arbitrary code in JSON):** `sum_fields`, `copy`, `sign_split_profit`/`sign_split_loss` (book result by sign), `abs`, `subtract`, `tax_attr` (read period tax attribute), `loss_closing` (opening + tax result, loss branch), `profit_closing`, `flag` (constant emitted when a tax attribute matches), `constant`.

**Emitters** live in `api/src/emitters/` and are shared across all packs: `sruLines.js` (Skatteverket `#UPPGIFT` blocks). A country needing an unsupported *format family* adds one emitter module; every later country on that format rides free. Emitters are code; descriptors are data.

## 4. Annual-report descriptors (`filings/annual-report.json`) — DESCOPED 2026-07-30

**SE årsredovisning production + submission is owned by Gredor (open source, free), fed by the freebooks SIE 4 export — this section is retained as design reference only; no build is planned.** The shipped `report?type=ar` K2 composite predates the descope and is frozen as a read-only viewer (no iXBRL, no note expansion, no K3 variant). If a future jurisdiction has no Gredor-equivalent, this design is the starting point.

The statutory report composite (Bolagsverket årsredovisning, ACRA FS, …): sections, line structure, comparatives. Shape:

```json
{
  "schema": 1,
  "id": "annual-report",
  "name": "Årsredovisning",
  "authority": "Bolagsverket",
  "variants": {
    "K2": {
      "statements": [
        { "id": "rr", "title": "Resultaträkning", "kind": "pl",
          "lines": [
            { "label": "Nettoomsättning", "subtypes": ["Revenue"] },
            { "label": "Övriga externa kostnader", "accounts": ["6570"], "sign": -1 },
            { "label": "Ränteintäkter", "subtypes": ["Financial Items"] }
          ] },
        { "id": "br", "title": "Balansräkning", "kind": "bs", "comparatives": 1, "lines": [] }
      ],
      "notes": [
        { "id": "principer", "title": "Not 1 — Redovisningsprinciper", "template": "K2_TEMPLATE" }
      ]
    }
  }
}
```

`variants` keyed by the company's `reporting_standard`. Lines reference accounts or account **subtypes** (the pack's own COA vocabulary — subtypes are already the report-section unit in the macros). The renderer (`api/src/report-composite.js`) produces the print-ready page; comparatives come from the prior period automatically.

## 5. What stays code

- Emitters per file-format family (`sruLines` now; `xbrl`, `xml`, fixed-CSV when needed).
- Conditional business logic that is not field arithmetic (e.g., Swedish loss-utilization *spärr* rules) — as engine *op* implementations, reviewed like any code.
- The pack linter (§6).

## 6. Pack validation (CI gate)

`tests/jurisdiction-packs.mjs` loads every `db/jurisdictions/*/` and asserts: manifest parses + `schema` known; every `accounts:[...]` reference in every descriptor exists in the pack's `coa.json`; every `subtypes:[...]` reference exists in the pack COA's subtype vocabulary; referenced emitters exist; `reportingStandards` non-empty; tax attribute keys unique. A broken pack fails the build with the file and key named. Runs in the existing contract-test harness (P1-2 pattern).

## 7. Migration from the 2026-07-29 state

1. Manifests for SE + SG (wrap the existing coa/vat packs).
2. `api/src/sru.js` → split into engine (`filings.js`) + `emitters/sruLines.js` + `SE/filings/ink2.json`. Routes unchanged (`/api/:company/sru/ink2`, `/sru/info`). **The golden test (`tests/sru-golden-2024.mjs`) is the acceptance contract — it must stay byte-identical green.**
   - ✅ DONE 2026-08-01 — engine `api/src/filings.js`, emitter `api/src/emitters/sruLines.js`, descriptor `db/jurisdictions/SE/filings/ink2.json` live; `api/src/sru.js` + `db/jurisdictions/SE/sru_ink2.json` deleted; routes rewired in `reports.js`; pack linter extended with an emitter-existence check.
3. `periods.tax_attrs` JSON column (idempotent ALTER, house style); Periods grid columns from the manifest; `ink2.js` descriptor constants (8041/8045) become `flag` ops on the declared attributes; `loss_cf` query param remains as an explicit override, period value is the default.
   - ✅ DONE 2026-08-01 — scope = `tax_attrs` column (pre-existing) + `flag` ops + `loss_cf` period-default; Periods-grid columns deferred per roadmap §0q API-first; company.attr defaults + rollforward proposal (§2) not yet built.
4. ~~K2 `annual-report.json` + composite renderer~~ — **CANCELLED 2026-07-30** (Gredor owns SE årsredovisning production/submission via the SIE 4 export; `report?type=ar` frozen as read-only viewer).
5. ~~SG `annual-report.json` as the seam-proof second pack~~ — **DESCOPED 2026-07-30** (no live SG need; resurrect if a jurisdiction without a Gredor-equivalent appears).

## 8. Contributor contract (for README)

> To add a country: create `db/jurisdictions/<CC>/` with `coa.json`, `vat_codes.json`, `jurisdiction.json`, and one descriptor per statutory filing/report. Run the pack linter. If your filing's file format already has an emitter, that's the whole job — no application code.
