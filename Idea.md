# Legwork

Legwork is a job-search agent available through Telegram, a direct paid API and
the Telegraph Protocol.

Its core output is a live, ranked shortlist. Each job is scored on a transparent
100-point rubric: skills 40, compensation 20, location 15, seniority 15 and
candidate priorities 10. Legwork can also tailor a resume, cover letter and
application email without inventing candidate experience.

## Telegraph Fit

- `WEB_SEARCH`: finds current postings from external job data sources.
- `RESEARCH_SYNTHESIS`: combines source results into one ranked, reasoned list.
- `TEXT_GENERATION`: drafts application materials from supplied candidate facts.

The miner is declarative: `miner.yaml` maps Telegraph requests to Legwork's
public `/miner/*` HTTP routes. Registration is permissionless on Base Sepolia,
requires no stake, and pays the registered fee address in MACHINA when routed
responses are selected and used.
