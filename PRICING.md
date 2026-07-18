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

## Marketplace listings (live in `src/okx/server.ts`)

| Listing | Price | What the buyer gets | Why this price |
|---|---|---|---|
| **Job Hunt** (`job-hunt`) — *the entry product* | **$2.00** | Criteria intake → user approves → agent hunts for 24h → ranked shortlist of up to 10 matches, every score explained per axis | Impulse-priced: low enough to try without thinking, ~20x margin over COGS, and it's the funnel into everything else. A human doing this search honestly costs an hour. |
| **Job Hunt Weekly** (`job-hunt-weekly`) | **$9.00** | Same approved criteria, hunted daily for 7 days, deduped (never the same posting twice) | 7 one-off hunts would be $14 — the ~35% bundle discount rewards commitment and creates recurring engagement without a subscription mechanism. |
| **Tailor One Application** (`tailor-one-application`) | **$4.00** | One posting: tailored resume variant + cover letter, delivered for approval, never fabricated | Highest perceived-value single unit (this is the task people hate most). Priced above hunt to signal it, still under "resume service" market rates ($25–100+). |
| **Job Search Sprint** (`job-search-sprint-7d`) — *the anchor bundle* | **$19.00** | Daily hunts + tailored drafts for top matches + approval-gated submission + weekly digest — the whole loop | À la carte equivalent ≈ $31 (weekly hunt $9 + ~4 tailors $16 + submissions). ~40% bundle discount makes it the obvious "serious searcher" choice, still ~6x margin. |

**Internal unit (not listed yet):** approval-gated submission + tracking ≈ **$1.50/each**
if we ever unbundle it. Kept inside the sprint for now — submission alone has
no value without a tailored draft.

## Pricing principles

1. **The hunt is the wedge, not the profit center.** $2 exists to get a
   first transaction and a shortlist worth screenshotting. Upsell happens in
   the thread: "Want me to tailor an application for #1? That's the $4 listing."
2. **Ladder the perceived effort.** Hunt ($2) < Tailor ($4) < Weekly hunt ($9)
   < Sprint ($19). Each step up is roughly 2x, which reads naturally.
3. **Never price below 5x COGS** — leaves room for LLM price changes, OKX
   marketplace fees, and dispute refunds without going underwater.
4. **Revisit after 50 settled tasks**: if hunt→sprint conversion is >15%,
   raise the sprint to $25; if hunts stall, drop to $1 before adding features.
