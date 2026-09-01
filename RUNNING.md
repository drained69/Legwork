# Running Legwork

## Local

```bash
npm install
cp .env.example .env
npm test
npm run dev
```

Without job-source or LLM keys, Legwork uses mock postings and deterministic
heuristics. The service still exposes its complete API and Telegraph miner
surface.

## Runtime

The process serves:

| Component | Route / trigger | Purpose |
|---|---|---|
| Health | `GET /health` | Liveness and miner identity |
| Catalog | `GET /api/services` | Direct per-call service prices |
| Free preview | `POST /api/hunt/preview` | Top three matches, 3 calls/hour/client |
| Paid API | `POST /api/hunt`, `/api/score`, `/api/tailor` | Direct Base Sepolia ERC-20 billing |
| Telegraph YAML | `GET /miner.yaml` | Byte-stable miner configuration |
| Telegraph miner | `POST /miner/job-hunt`, `/miner/tailor` | Open upstream endpoints called by Telegraph nodes |
| Telegram | long polling | Profile, wallet, preview and paid-service UI |

The `/miner/*` endpoints deliberately do not verify a direct payment. Telegraph
collects USDC from the requester and pays registered miners according to the
protocol. The direct `/api/*` endpoints retain their own Base Sepolia payment
verification for Telegram and third-party callers outside Telegraph.

## Environment

See `.env.example` for every variable. Important production settings:

- `PUBLIC_URL`: public HTTPS origin, currently `https://legwork-production-88e5.up.railway.app`
- `ADZUNA_APP_ID` / `ADZUNA_APP_KEY`: live general job data
- `USAJOBS_API_KEY`: live US federal jobs
- `ANTHROPIC_API_KEY`: LLM scoring, criteria extraction and tailoring
- `TELEGRAM_BOT_TOKEN`: optional Telegram surface
- `PAYMENT_ASSET_ADDRESS`, `PAYMENT_PAY_TO`: direct `/api/*` billing
- `WALLET_ENCRYPTION_KEY`: protects Telegram users' imported wallet keys
- `DATABASE_PATH`: SQLite path; use a persistent volume in production

## Redflag — buying miner answers through Telegraph

Redflag (`POST /api/redflag`, `/redflag` in Telegram) is Legwork's consumer
side: it pays other miners for scam, news, URL and fact checks via the node
engine (`POST /engine/v1/ask`, x402).

- `TELEGRAPH_NODE_URL`: engine base, default `https://devnode.telegraphprotocol.com`
- `TELEGRAPH_PRIVATE_KEY`: the wallet that pays miners. Fund it with Base
  Sepolia **USDC** (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`). x402
  signatures are EIP-3009 — gasless, no ETH burn. Without this key Redflag
  runs degraded (local scan + comp benchmark only) and says so in the report.
- `REDFLAG_MAX_SPEND_USD`: per-report miner spend ceiling, default `0.08`.
  Checks are price-probed before payment; anything over the remaining budget
  is skipped, never bought.
- `TELEGRAPH_CACHE_TTL_SEC`: identical queries reuse the cached signal
  instead of paying again (default 300s).

One live paid end-to-end check:

```bash
npx tsx scripts/redflag-smoke.ts "Senior Backend Engineer at Shopify, remote, $170k-$210k"
```

## Railway Deployment

The Railway project is named `legwork`; this workspace is linked to its
production environment.

```bash
railway variable set \
  PUBLIC_URL=https://legwork-production-88e5.up.railway.app \
  ADZUNA_APP_ID=... \
  ADZUNA_APP_KEY=... \
  ANTHROPIC_API_KEY=...
railway up --detach
```

Add Telegram and direct-payment secrets only if those surfaces are enabled.
After deployment:

```bash
curl -fsS https://legwork-production-88e5.up.railway.app/health
curl -fsS https://legwork-production-88e5.up.railway.app/miner.yaml | shasum -a 256
shasum -a 256 miner.yaml
```

The two hashes must match exactly before registration.

## Telegraph Registration

Legwork's miner identity is:

- ID: `8402`
- Slug: `legwork-job-hunter`
- Canonical intents: `WEB_SEARCH`, `RESEARCH_SYNTHESIS`, `TEXT_GENERATION`
- Floor price: `0.01 USDC` (`10000` in 6-decimal units)
- Registry Diamond: `0x5a2324aA18613FAD4e44bDF0d6c73Ec1f6D87ff8`
- Network: Base Sepolia
- **Current registrationId: `404`** (2026-09-01; supersedes `400`, `399`, `396` and `392`.
  Committed YAML hash
  `0x8d04aef3d50f5b28011656d4283c7b3b81cf6d162544da2dd0b49e02fecf04cd`.
  Each `updateMiner` issues a NEW id — find the latest with the dispatcher:
  `curl -s https://devnode.telegraphprotocol.com/miner-dispatcher/miners/address/<wallet>/yamls`)

Updating after any `miner.yaml` change (deploy FIRST — the script refuses when the
served hash differs from local):

```bash
set -a; source .env; set +a
scripts/register-miner.sh --update <currentRegistrationId>
```

Schema gotchas learned the hard way (each is a terminal `rejected` status):

- `accepted_fields` on a param must be an OBJECT in the live schema, not the
  array shown in some docs examples — omit it and put enum values in the
  param `description` instead.
- `input_schema`/`output_schema` are top-level only; anything else inside
  `endpoints[]` is rejected with "Additional property not allowed".

## Production environment requirements

Railway service `legwork` must carry (without them the miner serves mock
fixtures and template drafts, which validators score as junk):

- `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`, `ADZUNA_COUNTRY` — live job data
- `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` — criteria extraction, scoring,
  and the `/miner/tailor` generation path (verify in logs: a 401 means the
  key is stale and the keyless fallback is running)

```bash
railway variables list --service legwork --json
```

Recommended: paste `miner.yaml` into
[integrate.telegraphprotocol.com](https://integrate.telegraphprotocol.com),
sandbox-test both endpoints, connect the registering wallet, pin the YAML and
register.

CLI alternative:

```bash
export PUBLIC_URL=https://legwork-production-88e5.up.railway.app
export MINER_PRIVATE_KEY=0x...   # dedicated Base Sepolia wallet with gas ETH
export FEE_ADDRESS=0x...         # MACHINA payout address
scripts/register-miner.sh --dry-run
scripts/register-miner.sh
```

The script verifies the live YAML hash and all three canonical intents before
sending `registerMiner`.

## Verify Activation

Telegraph nodes normally activate a registration within a minute:

```bash
curl -s https://devnode.telegraphprotocol.com/api/miners \
  | jq '.[] | select(.slug=="legwork-job-hunter")'
```

If the miner is absent, query its registration ID directly and inspect
`activation_status` and `rejection_reason`. A rejected registration is fixed
with `scripts/register-miner.sh --update <registrationId>` after correcting and
redeploying `miner.yaml`.

## Verification

```bash
npm run typecheck
npm test
npm run build
```

The miner tests boot the real HTTP server on an ephemeral port and assert that
the served YAML is byte-identical, job-hunt responses expose `label`,
`confidence` and `reason`, and malformed requests return clean 4xx responses.
