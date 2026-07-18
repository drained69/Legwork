# Legwork — Pricing

## Per-call x402 API (primary — capped at $0.10/call, enforced in code)

Paid via the **OKX Agent Payments Protocol** (x402, scheme `exact`, USDC on
X Layer). The cap is asserted at module load in `src/okx/x402.ts` — a price
above $0.10 fails the build.

| Service | Endpoint | Price/call | COGS | Margin |
|---|---|---|---|---|
| Job Hunt (10 ranked matches) | `POST /api/hunt` | **$0.05** | ~$0.005–0.01 | ~5–10x |
| Score one posting | `POST /api/score` | **$0.01** | ~$0.001 | ~10x |
| Tailor one application | `POST /api/tailor` | **$0.10** | ~$0.04–0.08 | ~1.5–2.5x |

Why these three price points: score is the micro-unit other agents compose in
bulk (priced to be negligible per unit, profitable at volume); hunt is the
flagship call (one call = a humanly-useful deliverable); tailor sits exactly
at the cap because it burns the most LLM tokens — it is the one call where the
$0.10 ceiling binds, and it stays profitable only with prompt discipline.

> Prices are what the buyer pays on the OKX Task Marketplace (settled in
> USD-stable through the task lifecycle). Cost basis assumes Adzuna/USAJOBS
> free tiers and Claude Sonnet for scoring/tailoring.

## Per-activity cost basis (what one unit actually costs us)

| Activity | Compute involved | Est. COGS |
|---|---|---|
| One hunt pass | ~20 postings scraped (free tier) + 20 small LLM scoring calls | ~$0.05–0.10 |
| One tailored draft | 1 large LLM call (resume + cover letter + email) | ~$0.04–0.08 |
| One submission | Gmail API (free) + status tracking | ~$0.01 |
| 7-day sprint | ~28 hunt passes + ~10 drafts + submissions + digest | ~$2.50–3.50 |

## Launch pricing principle: one job, one price

The two channels sell the same work, so they must not disagree about what it
costs. A Telegram bundle is priced just above the API-call value of the work it
contains — the premium covers the chat UX, the approval loop, scheduling, and
persistence, not the analysis itself.

| Bundle | Work it contains | API-call value | Launch price |
|---|---|---|---|
| `job-hunt` (24h) | 4 scheduled hunts | $0.20 | **$0.25** |
| `job-hunt-weekly` (7d) | 28 hunts | $1.40 | **$1.00** (below cost of calls — deliberate: buys retention data) |
| `tailor-one-application` | 1 tailor call | $0.10 | **$0.25** |
| `job-search-sprint-7d` | 28 hunts + ~10 tailors | $2.40 | **$2.00** |

The earlier $2/$9/$4/$19 ladder charged up to **40x** the API price for
identical work (a $4 tailored application that costs $0.10 via API). For an
unproven agent that reads as arbitrary, and the first thing a curious buyer
does is compare the two lists.

**Free tier**: `POST /api/hunt/preview` returns the top 3 matches with scores,
free, 3 calls/hour per client. The cheapest way to prove quality is to let
people see real scored matches before any payment. It costs ~$0.01 to serve and
is rate-limited so it cannot substitute for the paid call.

**Revisit trigger**: raise prices only after ~50 settled tasks show repeat
usage. Cheap launch pricing buys the usage data; premium pricing without it is
guessing.

## Marketplace listings (live in `src/okx/server.ts`)

| Listing | Price | What the buyer gets | Why this price |
|---|---|---|---|
| **Job Hunt** (`job-hunt`) — *the entry product* | **$0.25** | Criteria intake → user approves → agent hunts for 24h → ranked shortlist of up to 10 matches, every score explained per axis | Below the price of anything a person deliberates over. The goal at launch is a first transaction and a shortlist worth screenshotting, not margin. |
| **Job Hunt Weekly** (`job-hunt-weekly`) | **$1.00** | Same approved criteria, hunted daily for 7 days, deduped (never the same posting twice) | Deliberately under the $1.40 of API calls it contains. A week of usage is the single most valuable thing to buy right now — it tells us whether people come back. |
| **Tailor One Application** (`tailor-one-application`) | **$0.25** | One posting: tailored resume variant + cover letter, delivered for approval, never fabricated | One $0.10 API call plus delivery. Priced level with the hunt so the natural upsell in-thread ("want me to tailor #1?") is a trivial yes. |
| **Job Search Sprint** (`job-search-sprint-7d`) | **$2.00** | Daily hunts + tailored drafts for top matches + approval-gated submission + weekly digest — the whole loop | The full week of work for the price of a coffee. Once retention data exists, this is the first listing to reprice upward. |

## Pricing principles

1. **The two channels must agree.** A job that costs $0.10 via API cannot cost
   $4 in Telegram. Bundle prices are derived from their API-call value, not set
   by feel.
2. **Launch prices buy data, not revenue.** At this stage the scarce resource
   is usage — people willing to test an unproven agent. Optimize for the first
   transaction; several bundles run at or below cost on purpose.
3. **Free before paid.** `POST /api/hunt/preview` shows real scored matches
   with no payment at all. Nothing converts a skeptic faster than seeing the
   scoring work on their own criteria.
4. **Keep the per-call API at or under $0.10** — enforced in code, so the cap
   cannot drift.
5. **Reprice only on evidence.** After ~50 settled tasks: if people return
   after their first hunt, raise the sprint first (it is the most underpriced).
   If they do not return, the problem is match quality, not price — fix that
   instead.
