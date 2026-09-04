# Legwork Service Catalog

## Telegraph

| Capability | Endpoint | Intents | Billing |
|---|---|---|---|
| Live job hunt and ranked synthesis | `POST /miner/job-hunt` | `WEB_SEARCH`, `RESEARCH_SYNTHESIS` | Telegraph, floor $0.01 |
| Resume and cover-letter tailoring | `POST /miner/tailor` | `TEXT_GENERATION` | Telegraph, floor $0.01 |
| Miner configuration | `GET /miner.yaml` | — | Free |
| Health | `GET /health` | — | Free |

Miner identity: `id: 8402`, `slug: legwork-job-hunter`, protocol `generic`.

## Direct API

| Capability | Endpoint | Price |
|---|---|---|
| The web app (hunt + vet) | `GET /` · `GET /redflag` | Free |
| Hunt the market (the miner's signal) | `POST /api/hunt/web` | Free, 6/hour |
| Preview top three matches | `POST /api/hunt/preview` | Free, 3/hour |
| Redflag free scam scan | `POST /api/redflag/preview` | Free, 3/hour |
| Redflag full vetting (operator-paid) | `POST /api/redflag/web` | Free to visitor, 2/hour + daily budget |
| Shareable report page (OG cards, web watch) | `GET /report/:id` · `GET /api/report/:id` | Free |
| Start / stop a web watch | `POST /api/report/:id/watch` · `/unwatch` | Free (~$0.01/check to operate) |
| Public network-usage stats | `GET /api/stats` | Free |
| Rank up to ten jobs | `POST /api/hunt` | $0.01 |
| Score one job | `POST /api/score` | $0.01 |
| Tailor one application | `POST /api/tailor` | $0.01 |
| Redflag due diligence on one posting | `POST /api/redflag` | $0.05 |
| Machine-readable catalog | `GET /api/services` | Free |

Paid direct routes use confirmed Base Sepolia ERC-20 transfers. Telegraph
routes are open upstreams because network billing happens before dispatch.

Redflag spends part of its price buying live checks from other Telegraph
miners (scam scan, company news, URL scan, fact check, ~$0.01 each) and
reports the per-check cost and provenance in every response. Paid reports are
persisted; `/watch Company` in Telegram adds a standing news watch (Legwork's
wallet pays, ~$0.01 per check) that alerts on new negative coverage.
