# Legwork

**A Telegraph miner for live job-market intelligence and application writing.**

Legwork turns a natural-language career request into a useful, explainable
answer. It searches live job boards, ranks openings against explicit criteria,
synthesizes advertised compensation, and produces application documents from
facts supplied by the caller. The service is available as a registered
[Telegraph Protocol](https://docs.telegraphprotocol.com/) miner, a direct HTTP
API, a Telegram bot, and a small web application.

The Telegraph integration is the product's primary distribution surface:
agents can discover Legwork by intent and pay per routed request in USDC. The
registered miner is intentionally simple to consume: send a request, receive a
structured signal, and inspect the reasoning and confidence behind it.

## Product Overview

Legwork provides three related capabilities:

- **Live job search:** queries Adzuna, USAJOBS, and Remotive at request time.
- **Transparent ranking:** scores results on skills, compensation, location,
  seniority, and caller-supplied priorities using a published 100-point rubric.
- **Application writing:** drafts resumes, cover letters, application emails,
  recruiter outreach, interview follow-ups, and LinkedIn summaries.

For salary questions, Legwork calculates a median, typical range, observed
range, and sample size from current postings that publish compensation. It does
not invent salary data or silently treat missing compensation as zero.

Application drafts follow a strict grounding policy: supplied candidate facts
are used as provided, while missing personal details remain clearly marked
placeholders rather than fabricated experience.

## Telegraph Miner

The registered miner is `legwork-job-hunter` (`id: 8402`) on Base Sepolia. Its
declarative configuration is maintained in [`miner.yaml`](miner.yaml), which is
served byte-for-byte at `/miner.yaml` for hash verification and registration.

| Capability | Telegraph route | Intent | Minimum price |
|---|---|---|---:|
| Live job search, ranking, and salary synthesis | `POST /miner/job-hunt` | `WEB_SEARCH`, `RESEARCH_SYNTHESIS` | `$0.01` |
| Application and general writing | `POST /miner/tailor` | `TEXT_GENERATION` | `$0.01` |

Telegraph handles payment and dispatch before calling these upstream routes;
the routes therefore do not implement direct payment verification. Every miner
response includes the protocol signal fields `label`, `confidence`, and
`reason`, along with capability-specific result fields such as `matches`,
`match_count`, `generatedText`, `resume`, and `coverLetter`.

### Example: job search

```bash
curl -X POST https://legwork-production-88e5.up.railway.app/miner/job-hunt \
  -H 'content-type: application/json' \
  -d '{"query":"senior backend engineer, TypeScript, remote, $150k+"}'
```

### Example: application writing

```bash
curl -X POST https://legwork-production-88e5.up.railway.app/miner/tailor \
  -H 'content-type: application/json' \
  -d '{
    "query":"Write a cover letter for this role",
    "candidate": {
      "name":"Alex Morgan",
      "resumeText":"Backend engineer with experience building TypeScript APIs.",
      "skills":["TypeScript","Node.js"]
    },
    "posting": {
      "title":"Senior Backend Engineer",
      "company":"Example Labs",
      "description":"Build reliable services for a growing product team."
    }
  }'
```

The complete request and response contract, supported fields, canonical intents,
and on-chain mapping are documented in [`miner.yaml`](miner.yaml).

## Architecture

```text
Telegraph request or Telegram/API request
                    |
                    v
             Legwork HTTP server
          /miner/*   /api/*   Telegram
                    |
       +------------+-------------+
       |                          |
 Live job sources              LLM layer
 Adzuna / USAJOBS /             Gemini or
 Remotive                      Anthropic
       |                          |
       +------------+-------------+
                    v
       Ranked signal or grounded document
                    |
              SQLite persistence
```

The service also includes **Redflag**, a Telegraph consumer workflow. Redflag
can vet a job posting or offer by purchasing scam, company-news, URL, and
fact-check signals from other miners through the Telegraph engine. Reports
include per-check provenance, confidence, cost, and a total spend ceiling.
Standing company watches can re-check news and surface new negative coverage
without alerting twice for the same story.

## Interfaces

| Interface | Routes or trigger | Purpose |
|---|---|---|
| Telegraph miner | `POST /miner/job-hunt`, `POST /miner/tailor` | Protocol-routed paid signals |
| Miner metadata | `GET /miner.yaml` | Byte-stable registration document |
| Health | `GET /health` | Service, source, LLM, and Telegraph status |
| Web app | `GET /` or `GET /redflag` | Free job hunt and posting vetting |
| Shareable reports | `GET /report/:id` | Public vetting receipt with social cards |
| Direct API | `POST /api/hunt`, `/api/score`, `/api/tailor`, `/api/redflag` | Base Sepolia paid services |
| Telegram | Long polling, `/menu`, `/profile`, `/redflag`, `/watch` | Conversational user workflow |
| Catalog | `GET /api/services` | Machine-readable direct-service pricing |

Direct API services verify confirmed Base Sepolia ERC-20 transfers using
`X-Payment-Tx` and `X-User-Wallet`. They are separate from Telegraph billing.
Current direct prices and preview limits are maintained in
[`PRICING.md`](PRICING.md).

## Quick Start

### Requirements

- Node.js 20 or newer
- npm
- Optional: Adzuna and USAJOBS credentials for additional live sources
- Optional: Gemini or Anthropic credentials for LLM-assisted scoring and writing

```bash
npm install
cp .env.example .env
npm run typecheck
npm test
npm run dev
```

The server listens on `PORT` (default `8402`). Without external job-source or
LLM credentials, the application uses its documented mock and deterministic
fallback paths so the HTTP surface remains available for development and
tests. For a complete local and production runbook, see
[`RUNNING.md`](RUNNING.md).

### Required production configuration

At minimum, configure:

- `PUBLIC_URL`, so Telegraph can retrieve `/miner.yaml`.
- `ADZUNA_APP_ID` and `ADZUNA_APP_KEY` for the primary live job source.
- `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` for model-assisted processing.
- `DATABASE_PATH` on durable storage when reports and watches must survive
  redeploys.

Add `TELEGRAM_BOT_TOKEN` to enable the Telegram surface. Add
`TELEGRAPH_PRIVATE_KEY` to enable Redflag's paid calls to other miners. See
[`.env.example`](.env.example) for the full configuration reference.

## Deploy And Register

The repository includes Docker, Railway, and Fly.io deployment configuration.
The production service must serve the same `miner.yaml` bytes that are hashed
and committed during registration.

1. Deploy the service and verify it is healthy.

   ```bash
   curl -fsS "$PUBLIC_URL/health"
   curl -fsS "$PUBLIC_URL/miner.yaml" | shasum -a 256
   shasum -a 256 miner.yaml
   ```

2. Confirm the two YAML hashes match exactly.

3. Register the miner with a dedicated Base Sepolia wallet containing gas ETH.

   ```bash
   export PUBLIC_URL=https://your-service.example
   export MINER_PRIVATE_KEY=0x...
   export FEE_ADDRESS=0x...
   scripts/register-miner.sh --dry-run
   scripts/register-miner.sh
   ```

4. Verify activation through the Telegraph node or the registration tools
   described in [`RUNNING.md`](RUNNING.md).

After changing `miner.yaml`, deploy first and then run
`scripts/register-miner.sh --update <registrationId>`. The script checks the
served YAML hash and canonical intents before submitting the transaction.

## Security And Data Handling

- Never commit `.env`, private keys, wallet data, SQLite databases, or generated
  deliverables.
- Use a dedicated testnet wallet for local Telegram payments; never import a
  wallet containing real funds.
- Keep OAuth scopes narrow when enabling Gmail integration.
- Treat candidate resumes and job postings as sensitive input and use durable
  storage only where required by the deployment.
- Configure `TRUST_PROXY=true` only when a trusted reverse proxy terminates
  connections in front of the service.
- Direct paid routes reject missing, invalid, or replayed payment transfers.
- Telegraph miner routes return structured, low-confidence fallback signals
  when an upstream source fails rather than presenting an unverified answer as
  reliable.

## Development Commands

```bash
npm run dev          # Run the TypeScript service directly
npm run typecheck    # Type-check without emitting files
npm test             # Run the test suite
npm run build        # Compile src/ to dist/
npm start            # Run the compiled service
```

Operational probes are available in `scripts/`, including `boot-check.ts`,
`self-probe.ts`, `e2e-check.ts`, and `redflag-smoke.ts`. Some probes call live
services or spend Base Sepolia USDC; review their source and environment before
running them.

## Repository Guide

- [`miner.yaml`](miner.yaml): Telegraph registration and I/O contract.
- [`RUNNING.md`](RUNNING.md): local operations, deployment, registration, and
  production verification.
- [`PRICING.md`](PRICING.md): direct API pricing and Telegraph cost notes.
- [`src/miner/miner.ts`](src/miner/miner.ts): Telegraph request handling and signal shaping.
- [`src/server.ts`](src/server.ts): HTTP routes and application surfaces.
- [`src/track3/`](src/track3/): Redflag, report, watch, and Telegraph consumer workflows.
- [`tests/`](tests/): unit, integration, miner, Telegram, web, and Redflag tests.

## Status

Legwork is an actively developed Telegraph integration and hackathon-oriented
product. The current deployment targets Base Sepolia and uses testnet USDC.
Production hardening, source availability, model quotas, and Telegraph routing
activation should be verified in the target environment before relying on the
service for business-critical workflows.
