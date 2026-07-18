# Legwork — Services & Costs

Snapshot of every external service Legwork depends on, whether it's live right
now, and what it costs. "Active" = credentials set and in use in the current
Railway deployment.

## Summary

**Current monthly spend: ~$0** — running on Railway's free trial credit, with
every paid/optional integration still disabled (the app falls back to mock job
data + heuristic scoring until keys are added).

## Services

| Service | Role in Legwork | Status | Current cost | Cost when scaled |
|---|---|---|---|---|
| **Railway** | Hosting (container + `/data` volume + public HTTPS) | ✅ Active — Online | $0 (free trial credit) | ~$5/mo Hobby + usage (CPU/RAM/volume) |
| **Telegram Bot API** | The only user surface (onboarding, cards, approvals) | ✅ Active — bot online | Free | Free |
| **SQLite (better-sqlite3)** | Local DB on the Railway volume | ✅ Active | $0 (bundled in Railway volume) | Volume storage billed by Railway |
| **OKX AI marketplace / ERC-8004 registry** | Where engagements are hired & settled; agent identity | ⚠️ Not registered (`OKX_AGENT_ID` empty) | $0 | On-chain gas for agent wallet + any marketplace fee/take-rate |
| **Adzuna API** | Job source (`job-scraper`) | ⚠️ Not enabled (no key) | $0 | Free tier; paid tiers only at high volume |
| **USAJOBS API** | Job source (US federal, `job-scraper`) | ⚠️ Not enabled (no key) | $0 | Free |
| **Anthropic Claude API** | Scoring + tailoring (`match-scorer`, `application-tailor`) | ⚠️ Not enabled → heuristic fallback | $0 | Pay-per-token (~cents per application at Sonnet rates) |
| **Gmail API** | Send applications from user's real inbox (`apply-executor`) | ⚠️ Not enabled → prepared-with-link | $0 | Free |

## Notes

- **Railway** is the only thing that will ever bill you for the app itself. The free trial credit is finite; expect ~$5/mo (Hobby) once it runs out.
- **OKX** is the revenue side, not just a cost — listings `job-search-sprint-7d` ($25) and `tailor-one-application` ($3) are what buyers pay. The only real cost is gas on the dedicated agent wallet.
- **Anthropic** is the main variable cost once enabled — it scales with how many postings get scored/tailored. Until a key is set, Legwork uses deterministic heuristics for free.
- **Adzuna, USAJOBS, Telegram, Gmail** are all free at Legwork's expected volume.

## Enable-later checklist

- [ ] Register on OKX ERC-8004 registry → set `OKX_AGENT_ID`, fund agent wallet with gas
- [ ] Add `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` for real (non-mock) job data
- [ ] Add `ANTHROPIC_API_KEY` for LLM scoring/tailoring
- [ ] Add `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REFRESH_TOKEN` for real sends
- [ ] Decide on Railway plan before trial credit runs out
