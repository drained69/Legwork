# Running Legwork

## Quick start (no keys needed)

```bash
npm install
npm run demo        # full end-to-end loop with mock data:
                    # OKX hire → Telegram bind → scan → score → tailor →
                    # approval gate → submission → digest → OKX settlement
```

## Real deployment

```bash
cp .env.example .env   # fill in what you have — everything degrades gracefully
npm run dev            # tsx, or: npm run build && npm start
```

The process runs three things:

| Component | Enabled by | Without it |
|---|---|---|
| Telegram bot (long polling) | `TELEGRAM_BOT_TOKEN` | Disabled; endpoint + scheduler still run |
| OKX A2A endpoint (`:8402`, `POST /okx/a2a`) | always on | — |
| Scheduler (scan 6h / digest Mon / delivery hourly) | always on | — |

Feature flags by key:

- **Job sources** — `ADZUNA_APP_ID`/`ADZUNA_APP_KEY` and/or `USAJOBS_API_KEY`. With neither set, mock fixtures are used (demo mode).
- **LLM scoring + tailoring** — `ANTHROPIC_API_KEY`. Without it, deterministic heuristics (keyword-overlap skills score, template drafts).
- **Real email submission** — `GMAIL_CLIENT_ID`/`GMAIL_CLIENT_SECRET`/`GMAIL_REFRESH_TOKEN` (scope: `gmail.send` only). Without them, submissions are simulated and receipted as such.
- **OKX inbound auth** — `OKX_INBOUND_SECRET` (checked against the `x-okx-secret` header) until registry signature verification is wired.

## The flow in production

1. Register Legwork on the OKX ERC-8004 agent registry with your public HTTPS URL for `/okx/a2a`, category *Resume & Career Workflows*.
2. Buyer hires a listing (`job-search-sprint-7d` or `tailor-one-application`) on the OKX Task Marketplace.
3. OKX posts `task_assigned` to the endpoint → Legwork replies in the task chat with a one-time deep link `t.me/<bot>?start=<code>`.
4. Buyer opens the link → `/start <code>` binds their Telegram account → onboarding conversation collects the profile.
5. Scheduler scans every 6h → match cards with the explicit rubric breakdown land in the thread.
6. Buyer taps **Approve** → sees the exact email → taps **Send now** → apply-executor submits (hard-gated on the recorded approval; the draft is frozen as dispute evidence).
7. Weekly digest in Telegram; at engagement end the digest + evidence bundle is delivered through the OKX task lifecycle; `delivery_accepted` settles payment.

## Telegram commands

`/start <code>` `/profile` `/rubric [threshold N | cap N]` `/scan` `/status` `/digest` `/pause` `/resume` `/revoke` `/help`

## Testing the OKX endpoint locally

```bash
curl -s localhost:8402/health
curl -s -X POST localhost:8402/okx/a2a -H 'content-type: application/json' \
  -d '{"jobId":"j1","message":{"source":"system","event":"task_assigned","jobId":"j1"}}'
```

## Layout

```
src/
  index.ts                 process entry (bot + OKX endpoint + scheduler)
  demo.ts                  keyless end-to-end demo
  config.ts  types.ts  db.ts  llm.ts  pipeline.ts  digest.ts  scheduler.ts
  telegram/bot.ts          the ONLY user surface: onboarding, cards, approvals
  okx/server.ts            A2A endpoint, listings, task lifecycle, payments log
  skills/
    jobScraper.ts          Adzuna + USAJOBS + mock, normalize, dedupe
    matchScorer.ts         rubric 40/20/15/15/10, every sub-score has a reason
    applicationTailor.ts   resume + cover letter + email (never fabricates)
    applyExecutor.ts       approval-gated submission, Gmail send, receipts
```
