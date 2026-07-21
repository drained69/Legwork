# Running Legwork

## Quick start (no keys needed)

```bash
npm install
npm test            # 19-test pre-launch suite: approval gate, idempotency,
                    # OKX lifecycle, scoring rubric, dedupe, daily cap
npm run demo        # full end-to-end loop with mock data:
                    # OKX hire → Telegram bind → scan → score → tailor →
                    # approval gate → submission → digest → OKX settlement
```

## Real deployment

```bash
cp .env.example .env   # fill in what you have — everything degrades gracefully
npm run dev            # tsx, or: npm run build && npm start
```

The process runs four things:

| Component | Enabled by | Without it |
|---|---|---|
| **OKX marketplace poller** (claims tasks every 30s) | `OKX_ASP_AGENT_ID` + a signed-in service wallet | **Tasks addressed to this agent expire unclaimed — buyers see a provider that timed out** |
| Telegram bot (long polling) | `TELEGRAM_BOT_TOKEN` | Disabled; endpoint + scheduler still run |
| OKX A2A endpoint (`:8402`, `POST /okx/a2a`) | always on | — |
| Scheduler (scan 6h / digest Mon / delivery hourly) | always on | — |

## The marketplace poller

OKX does not guarantee a push for every task that names this agent, and a task
sitting in `created` is expired by the backend. The provider is expected to
**pull**. Each cycle the poller reads every task routed to `OKX_ASP_AGENT_ID`
and moves it forward:

| Task status | Poller action |
|---|---|
| `created` | `contact-user` (opens the buyer chat), then `apply` on-chain when the task designates us and the budget is within `OKX_MAX_AUTO_APPLY_BUDGET` |
| `accepted` | escrow funded → extract criteria from the buyer's brief, run the hunt, `deliver` the ranked shortlist on-chain |
| `submitted` | nothing — awaiting buyer review |
| `completed` | mark settled, notify the bound Telegram user |
| `expired` / `closed` / `refunded` | close the engagement locally |

It also heartbeats every 5 minutes (`recommend-task` only matches agents that
look online) and, once the listing is approved, cold-starts on relevant public
tasks — contact only, never `apply`, since on a public task the buyer has not
chosen us yet.

Verify it against a live account without touching the chain:

```bash
npm run okx:poll            # readiness + task list + what a live tick would do
npm run okx:poll -- --live  # actually claim
```

A healthy dry run looks like:

```
gate-check: ready=true wallet=true identity=true comms=true signed-in-agent=6658
8 task(s) routed to this agent:
  [created] 0x4931…f04d — 2 USDT — "Help find tech job matches"
  ⚠ 8 task(s) still in "created" — these expire if the agent never claims them.
```

If `gate-check` reports `ready=false`, the service wallet is not signed in:
run `onchainos wallet login` with `ONCHAINOS_HOME` pointed at
`OKX_ONCHAINOS_HOME`, then re-run the poll.

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
