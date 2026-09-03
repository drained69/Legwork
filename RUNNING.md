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
| Redflag web app | `GET /redflag` | Paste-box vetting: free scan + operator-paid full vetting, stats, recent verdicts |
| Redflag free scan | `POST /api/redflag/preview` | Local scam scan + comp benchmark, 3 calls/hour/client |
| Redflag full vetting | `POST /api/redflag/web` | Operator-paid miner checks, 2/hour/client + daily budget |
| Shareable report | `GET /report/:id`, `GET /api/report/:id` | A vetting's receipt by unguessable id |
| Public stats | `GET /api/stats` | Reports run, checks bought, USDC paid to miners |
| Paid API | `POST /api/hunt`, `/api/score`, `/api/tailor` | Direct Base Sepolia ERC-20 billing |
| Redflag report | `POST /api/redflag` | $0.05 — buys 4 live miner checks, persists the report |
| Telegraph YAML | `GET /miner.yaml` | Byte-stable miner configuration |
| Telegraph miner | `POST /miner/job-hunt`, `/miner/tailor` | Open upstream endpoints called by Telegraph nodes |
| Telegram | long polling | Profile, wallet, preview and paid-service UI |
| Watch poller | every REDFLAG_WATCH_POLL_MINUTES | Standing company-news watches → Telegram alerts |

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

Redflag (`POST /api/redflag`, `/redflag` in Telegram; free scan at `GET /redflag`
and `/redflagfree`) is Legwork's consumer side: it pays other miners for scam,
news, URL and fact checks via the node engine (`POST /engine/v1/ask`, x402).

- `TELEGRAPH_NODE_URL`: engine base, default `https://devnode.telegraphprotocol.com`
- `TELEGRAPH_PRIVATE_KEY`: the wallet that pays miners. Fund it with Base
  Sepolia **USDC** (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`). x402
  signatures are EIP-3009 — gasless, no ETH burn. Without this key Redflag
  runs degraded (local scan + comp benchmark only) and says so in the report;
  standing watches are disabled entirely (they exist to buy news checks).
- `REDFLAG_MAX_SPEND_USD`: per-report miner spend ceiling, default `0.08`.
  Checks are price-probed before payment; anything over the remaining budget
  is skipped, never bought.
- `TELEGRAPH_CACHE_TTL_SEC`: identical queries reuse the cached signal
  instead of paying again (default 300s).
- `REDFLAG_WATCH_INTERVAL_HOURS`: how often a standing watch re-checks its
  company's news (default 6).
- `REDFLAG_WATCH_CHECK_BUDGET_USD` / `REDFLAG_WATCH_TICK_BUDGET_USD`: ceiling
  per news check (default 0.02) and per poller sweep across ALL watches
  (default 0.20) — a hundred subscribers cannot drain the wallet in one sweep.
- `REDFLAG_WATCH_POLL_MINUTES`: how often the watch poller wakes (default 15).
- `REDFLAG_WEB_FULL_RATE_PER_HOUR` / `REDFLAG_WEB_DAILY_BUDGET_USD`: the public
  web app's operator-paid full vetting — per-IP rate limit (default 2/hour)
  and daily spend ceiling (default $3.00, read from the reports ledger so it
  survives restarts). Over either limit the button refuses honestly and the
  free scan keeps working. **Set `TELEGRAPH_PRIVATE_KEY` in production or the
  full-vetting button answers 503** — the web app is the Telegraph consumer
  surface, and its whole point is buying live miner checks.

Paid reports persist to SQLite (`redflag_reports`); watches live in
`redflag_watches`. `TRUST_PROXY=true` is required in production for the free
scan's per-client rate limit to see real client IPs behind Railway's proxy.

Live operational checks (all spend real testnet USDC):

```bash
npx tsx scripts/redflag-smoke.ts "Senior Backend Engineer at Shopify, remote, $170k-$210k"   # one paid report
npx tsx scripts/live-check.ts        # every flow: page, free scan, paid HTTP path, persistence, watch tick
npx tsx scripts/boot-check.ts        # boots the full process with everything external off
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
- **Current registrationId: `409`** (2026-09-02; supersedes `404`, `400`, `399`,
  `396` and `392`. Committed YAML hash
  `0x09190216708c49b2af81aef7ae879fceddffd70aca03f69c49ac5aabb7195138`.
  Each `updateMiner` issues a NEW id — the dispatcher's `/yamls` endpoint can
  return an empty list even for an active registration, so scan
  `getMiner(uint256)` IDs on the Diamond for the registering wallet when in
  doubt: `cast call $DIAMOND "getMiner(uint256)" <id> --rpc-url $RPC`)

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
