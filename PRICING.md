# Legwork Pricing

## Telegraph Miner

The registered floor price is **0.01 USDC per routed request**. Telegraph
collects the payment from the requesting agent, sends 2% to the protocol
treasury, and settles the remaining 98% to the registered fee address in
MACHINA through the protocol's TWAP process.

Actual routed prices can be higher when a canonical intent has strong 24-hour
demand. Telegraph routing and miner scoring determine traffic share.

| Endpoint | Canonical use | Floor |
|---|---|---|
| `POST /miner/job-hunt` | `WEB_SEARCH`, `RESEARCH_SYNTHESIS` | $0.01 |
| `POST /miner/tailor` | `TEXT_GENERATION` | $0.01 |

## Direct API

These routes are independent of Telegraph and verify a direct ERC-20 transfer
on Base Sepolia:

| Service | Endpoint | Price |
|---|---|---|
| Job Hunt, up to 10 ranked matches | `POST /api/hunt` | $0.01 |
| Score one posting | `POST /api/score` | $0.01 |
| Tailor one application | `POST /api/tailor` | $0.01 |
| Redflag due diligence on one posting | `POST /api/redflag` | $0.05 |
| Redflag free scam scan | `POST /api/redflag/preview`, `GET /redflag` | Free, 3/hour/client |
| Top-three preview | `POST /api/hunt/preview` | Free, 3/hour/client |

Direct callers submit `X-Payment-Tx` and `X-User-Wallet`. The server verifies a
confirmed transfer to `PAYMENT_PAY_TO` on `PAYMENT_ASSET_ADDRESS` and rejects
transaction-hash replay.

## Cost Notes

- Job sources use Adzuna and USAJOBS self-serve tiers.
- Without an Anthropic key, scoring and tailoring use deterministic fallbacks.
- A hunt can score up to 20 postings, so LLM usage is the primary variable cost.
- Telegraph exposes one miner floor across the registration; keep it at $0.01
  until live volume and scoring data justify an update.
- Redflag is priced at $0.05 because a report BUYS up to four live miner
  answers through the Telegraph engine (~$0.04 at floor prices, demand
  multipliers can raise this) on top of the local scam scan and comp
  benchmark. Miner spend per report is hard-capped by `REDFLAG_MAX_SPEND_USD`
  (default $0.08): every check is price-probed before payment and skipped when
  it would exceed the remaining budget. Telegraph answers are cached per
  subject (`TELEGRAPH_CACHE_TTL_SEC`, default 300s), so repeat reports on the
  same company do not re-pay for the same signal.
- Standing watches (`/watch Company` in Telegram) are paid by LEGWORK, not the
  subscriber: ~$0.01 per news check at the default cadence, capped per check
  (`REDFLAG_WATCH_CHECK_BUDGET_USD`, $0.02) and per poller sweep
  (`REDFLAG_WATCH_TICK_BUDGET_USD`, $0.20). A watch alerts only on NEW
  negative coverage (fingerprint-deduplicated), so the same story never
  costs twice.
