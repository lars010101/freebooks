# Skuld ⚖️

**Open-source financial workbook for small companies.**

Skuld is a Google Sheets-based accounting system with a BigQuery data layer and Cloud Functions logic engine. You own your data — everything runs in your own Google Cloud project.

## Features

- **Double-entry bookkeeping** with full journal entry validation
- **Bank statement processing** with rule-based and AI-assisted categorisation
- **Accounts Payable** — bill registration, posting, payment matching, aging reports
- **Multi-currency** with automatic FX rates from ECB
- **VAT/GST support** with auto-splitting and periodic return generation
- **Profit/cost centers** for departmental reporting
- **Financial reports** — Trial Balance, P&L, Balance Sheet, Cash Flow, Dashboard
- **Journal reversal** — immutable ledger with proper audit trail
- **AI-powered** (optional, BYOK) — account classification, bank categorisation, report generation
- **Multi-jurisdiction** — Sweden (BAS/K2), Singapore (SFRS), extensible via community packs

## Architecture

```
Google Sheets (UI) → Apps Script (relay) → Cloud Functions (logic) → BigQuery (data)
```

- **Sheets** = your interface. Data entry, reports, settings.
- **Cloud Functions** = all business logic. Validation, VAT, bank processing, reports.
- **BigQuery** = source of truth. All financial data stored here.
- **Apps Script** = thin relay. ~20 lines per function. No business logic, no timeout risk.

Everything runs in **your** Google Cloud project. Skuld provides the code, you own the infrastructure.

## Quick Start

### Method A: One-Click (Recommended)

1. [Copy the Skuld template](link-to-template) (Google Sheets)
2. Open the sheet → Menu → **⚖️ Skuld** → **Setup**
3. Follow the wizard — it creates your BigQuery dataset and deploys Cloud Functions automatically
4. Done. Start entering transactions.

### Method B: CLI (Developers)

```bash
git clone https://github.com/skuld-finance/skuld.git
cd skuld
npm install --prefix functions

# Configure your GCP project
export GCP_PROJECT=your-project-id

# Deploy
./deploy/setup.sh
./deploy/clasp-push.sh
```

## Jurisdictions

| Country | COA | VAT | Status |
|---------|-----|-----|--------|
| 🇸🇪 Sweden | BAS (small company) | Moms (25/12/6/0/RC) | ✅ Ready |
| 🇸🇬 Singapore | SFRS | GST (9/0/exempt/RC) | ✅ Ready |
| 🇬🇧 UK | — | — | 📋 Planned |
| 🇩🇪 Germany | — | — | 📋 Planned |

### Add Your Country

See [CONTRIBUTING.md](CONTRIBUTING.md) and `jurisdictions/_template/`. PRs welcome!

## AI Integration (Optional)

Skuld works fully without AI. To enable AI features:

1. Get an API key from [Anthropic](https://console.anthropic.com/), [OpenAI](https://platform.openai.com/), or [Google AI](https://aistudio.google.com/)
2. Enter it in Settings → AI Provider + API Key
3. AI now assists with: bank categorisation, account classification, report narrative generation

**You pay for your own AI usage.** Skuld never sees or stores your API calls.

## Cost

| Component | Cost |
|-----------|------|
| Skuld | Free (AGPL-3.0) |
| Google Sheets | Free |
| BigQuery | Free tier (10 GB storage, 1 TB queries/month) |
| Cloud Functions | Free tier (2M invocations/month) |
| AI (optional) | Your API key, ~$0.50-2.00 per report |

**Total for typical small company usage: $0/month.**

Google requires a billing-enabled GCP project (credit card on file) even for free tier. Skuld auto-sets a $1 budget alert so you're notified before any charges.

## Support This Project

Skuld is free and open source. If it saves you time or money:

- ⭐ Star this repo
- ☕ [Buy me a coffee](link)
- 💖 [GitHub Sponsors](link)

## License

[AGPL-3.0](LICENSE) — free to use, modify, and distribute. If you offer a modified version as a service, you must open-source your changes.

## Documentation

- [Setup Guide](docs/setup-guide.md)
- [User Manual](docs/user-manual.md)
- [Adding a Jurisdiction](docs/adding-jurisdiction.md)
- [Architecture](docs/architecture.md)
- [Design Document](../design/financial-workbook-v2.md)
