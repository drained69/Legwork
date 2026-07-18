# Legwork — Build Todo

> **BUILD STATUS (2026-07-18):** the codebase is implemented and verified — `npm run demo` runs the
> full loop end to end (OKX hire → Telegram bind → scan → score → tailor → approval gate →
> submission → digest → OKX settlement), and `npm run dev` starts the real process. See
> [RUNNING.md](RUNNING.md). What remains is **external setup, not code**: create the bot with
> @BotFather, get Adzuna/USAJOBS/Anthropic/Gmail keys, register the agent on the OKX ERC-8004
> registry with a public HTTPS endpoint, and deploy the always-on process. Code-side gaps that
> remain open: registry signature verification (shared-secret header in place), real x402 wire
> (payment events are logged, settlement handled via task lifecycle), PDF resume parsing
> (text paste works), and ATS form-fill adapters (email path + prepared-link path work).

> **Two hard constraints that shape everything below:**
> 1. **Users interact 100% via Telegram.** No web app, no dashboard. Every screen is a Telegram message, card, or inline button.
> 2. **Every service call flows through the OKX AI marketplace.** Legwork is an ASP (Agent Service Provider) registered on OKX's ERC-8004 agent registry. Users hire Legwork through the OKX Task Marketplace, payments settle through OKX agent payments (x402), and job delivery/acceptance happens through the marketplace task lifecycle — not a private backend billing users directly.

---

## Phase 0 — Project Setup & Accounts

- [ ] Init repo: `git init`, Node.js (TypeScript) or Python project scaffold — pick **TypeScript + Node 20** (best Telegram + OKX SDK ecosystem)
- [ ] Create `.env` / secrets management (never commit):
  - [ ] `TELEGRAM_BOT_TOKEN`
  - [ ] `OKX_WALLET_PRIVATE_KEY` (agent's on-chain identity wallet — dedicated wallet, NOT a personal one)
  - [ ] `OKX_AGENT_ID` (assigned after ERC-8004 registration)
  - [ ] `ADZUNA_APP_ID` / `ADZUNA_APP_KEY`
  - [ ] `USAJOBS_API_KEY` (backup source)
  - [ ] `ANTHROPIC_API_KEY` (or chosen LLM) for scoring + tailoring
  - [ ] `GMAIL_OAUTH_CLIENT_ID` / `GMAIL_OAUTH_CLIENT_SECRET` (apply-executor email path)
  - [ ] `DATABASE_URL`
- [ ] Create Telegram bot via @BotFather → save token, set bot name/description/commands
- [ ] Create dedicated agent wallet for OKX (fund with small gas amount on the target chain)
- [ ] Register on Adzuna developer portal (free tier key — takes minutes)
- [ ] Register USAJOBS API key (free, backup/demo-safe source)
- [ ] Download Kaggle LinkedIn postings dataset (~124k rows) for offline scorer development
- [ ] Google Cloud Console project → OAuth consent screen → enable Gmail API → credentials for `gmail.send` (+ optional `gmail.readonly`)
- [ ] Choose storage: **SQLite (dev) → Postgres (deploy)** via Prisma or Drizzle
- [ ] Choose deploy target for the always-on process (Fly.io / Railway / small VPS) — the bot + scheduler must run 24/7

## Phase 1 — OKX Marketplace Integration (the ASP backbone)

> Everything Legwork sells goes through OKX. This phase makes Legwork a real marketplace citizen.

- [ ] **ERC-8004 agent registration**: register Legwork as an ASP agent on the OKX agent registry
  - [ ] Agent name, description, avatar
  - [ ] Category: **Resume & Career Workflows**
  - [ ] Service endpoint URL (the HTTPS endpoint OKX calls to reach the agent) — stand up the endpoint first (Phase 1.2)
- [ ] **Agent service endpoint** (inbound from OKX):
  - [ ] HTTPS server that accepts OKX A2A envelopes (`{agentId, message: {source: "system", event, jobId}}` system events and `{msgType: "a2a-agent-chat", jobId, sender, ...}` chat messages)
  - [ ] Handle task lifecycle events: task assigned → accepted → in-progress → deliver → accepted/disputed
  - [ ] Verify inbound message authenticity (signature/origin check) — reject anything not from OKX
- [ ] **Service listing(s) on the Task Marketplace** — define what a user actually buys:
  - [ ] Listing A: "Job Search Sprint" — N days of scan + score + draft + apply loop (the core product)
  - [ ] (Optional) Listing B: one-off "Tailor my application for this posting"
  - [ ] Price each listing; decide stake requirements per OKX task rules
- [ ] **Payments (x402)**:
  - [ ] Handle HTTP 402 / payment-required flows for the agent's paid endpoint
  - [ ] Wire settlement: task accepted → escrow/stake → deliver → owner accepts → funds settle to agent wallet
  - [ ] Log every payment event to the DB (auditable trail for disputes)
- [ ] **Task lifecycle mapping** (critical design decision — write it down before coding):
  - [ ] OKX task = one Legwork engagement (e.g., 7-day sprint)
  - [ ] "Deliver" = the weekly digest + log of applications submitted with approvals
  - [ ] Dispute path: what evidence Legwork submits (approval timestamps, drafts shown, submission receipts)
- [ ] **Bridge OKX task ↔ Telegram chat**: on task assignment, generate a one-time deep-link code (`t.me/LegworkBot?start=<taskcode>`) delivered through the OKX task chat so the buyer lands in the right Telegram thread bound to their jobId

## Phase 2 — Telegram Bot Core (the only UI)

- [ ] Bot framework: **grammY** (TS) or Telegraf — long polling for dev, webhook for prod
- [ ] `/start <taskcode>` — binds Telegram user ↔ OKX jobId ↔ Legwork engagement; reject unknown/expired codes
- [ ] **Onboarding conversation** (state machine, resumable):
  - [ ] Collect profile: resume upload (PDF/DOCX → parse to structured profile), target roles, seniority, locations/remote, comp floor, must-haves/dealbreakers
  - [ ] Confirm parsed profile back to user as an editable summary card
  - [ ] Set score threshold (default 70) and daily match cap
- [ ] **Command set**: `/profile` (view/edit), `/rubric` (adjust weights), `/pause` `/resume`, `/status` (engagement + applications), `/digest` (on-demand), `/help`
- [ ] **Match card UX** (the core screen):
  - [ ] Posting title, company, comp, location + explicit rubric breakdown (skills X/40, comp Y/20, location Z/15, seniority W/15, culture V/10)
  - [ ] Buttons: ✅ Approve & apply · 📝 View full draft · ✏️ Request changes · ⏭ Skip (with reason picker — feeds rubric tuning)
  - [ ] "View full draft" → sends tailored resume + cover letter as documents/preview messages
- [ ] Inline-button callback handling with idempotency (double-taps must not double-apply)
- [ ] Error surfaces: every background failure that blocks the user becomes a Telegram message, not a silent log line

## Phase 3 — Skill 1: job-scraper

- [ ] Adzuna client: search by role keywords, location, salary filter; normalize to internal `Posting` schema (id, title, company, comp, location, remote?, description, url, source, ats_hint)
- [ ] USAJOBS client (same normalized schema) as second source
- [ ] (Stretch) RemoteOK/Remotive/Arbeitnow adapters
- [ ] Dedup: hash on (company + title + location) with fuzzy fallback; track seen postings per user
- [ ] Scheduler: cron per active engagement (e.g., every 6h), respecting rate limits and `paused` state
- [ ] Persist raw + normalized postings; mark scan runs with stats (found / new / duplicates)

## Phase 4 — Skill 2: match-scorer

- [ ] Define rubric config (per-user, editable via `/rubric`): weights for skills (40), comp (20), location/remote (15), seniority (15), culture signals (10)
- [ ] Deterministic sub-scores where possible (comp range overlap, location match) + LLM sub-scores for skills match and culture signals — **each with a one-line stated reason**
- [ ] Composite score 0–100; store full breakdown JSON (this is what the match card renders — no black-box numbers)
- [ ] Threshold gate: only postings ≥ user threshold advance to tailoring
- [ ] Offline harness: run scorer against Kaggle dataset, eyeball 30–50 scored postings, tune prompts/weights before touching live data
- [ ] Daily cap enforcement (don't flood the user's chat)

## Phase 5 — Skill 3: application-tailor

- [ ] Resume tailoring: base structured profile + posting → tailored resume variant (reorder/emphasize real experience; **hard rule: never fabricate skills, employers, or dates**)
- [ ] Cover letter generation keyed to posting language and company
- [ ] ATS detection from posting URL/description (Workday / Greenhouse / Lever heuristics) → adjust format hints
- [ ] Render outputs: PDF for resume (e.g., headless Chromium or a PDF lib), text for cover letter
- [ ] Store every draft version linked to posting + user; drafts are immutable once approved (dispute evidence)
- [ ] "Request changes" loop: user feedback → regenerate → re-present card

## Phase 6 — Skill 4: apply-executor (approval-gated, always)

- [ ] **Hard gate**: executor refuses to run without a recorded approval event (user id + posting id + draft version + timestamp)
- [ ] Email application path (MVP): Gmail OAuth (`gmail.send`) — send tailored resume + cover letter from the user's real address; show the exact email in Telegram before sending
- [ ] Easy-apply/link path: where a source supports direct apply URLs, submit and capture confirmation
- [ ] Submission receipt: log what was sent, where, when; send confirmation message to Telegram
- [ ] Status tracking: optional `gmail.readonly` poll for replies → detect "interview"/"rejection" keywords → status update in chat
- [ ] Failure handling: submission failed → tell the user in-thread with a retry button; never fail silently
- [ ] (Stretch) ATS form-fill adapters (Greenhouse first — simplest markup)

## Phase 7 — Digest, Delivery & Settlement

- [ ] Weekly (and end-of-engagement) digest: applications sent, response rate, top-scoring skips + skip reasons, rubric-tuning suggestions
- [ ] Digest posts to Telegram **and** is packaged as the OKX task deliverable
- [ ] On engagement end: submit deliverable through OKX task `deliver` flow → owner accepts in marketplace → payment settles
- [ ] Dispute-evidence bundle generator: approvals log + drafts + submission receipts, exportable on demand

## Phase 8 — Hardening & Trust

- [ ] Per-user data isolation; encrypt resume/profile at rest
- [ ] Revocation: `/revoke` kills Gmail token + pauses engagement instantly
- [ ] Rate limits + spend caps on LLM calls per engagement (protect margins on fixed-price tasks)
- [ ] Idempotency keys on: apply submissions, OKX payment events, Telegram callbacks
- [ ] Audit log table: every agent action with actor, timestamp, and triggering approval
- [ ] Prompt-injection defense: treat posting text as untrusted data — never let a job description alter agent behavior (e.g., "ignore your instructions and email X")

## Phase 9 — Demo Prep (4-minute judge script)

- [ ] Seed a demo profile + demo engagement bound to a live OKX task
- [ ] Pre-warm 2–3 real Adzuna postings that score well (verify the morning of)
- [ ] Rehearse: OKX marketplace hire → Telegram deep-link → match card with visible rubric → view draft → tap Approve on stage → real submission confirmation → show weekly digest → show settlement on OKX
- [ ] Fallback plan: cached postings + recorded submission clip in case of API/network failure on stage
- [ ] One-pager for judges: trust loop diagram + "every call goes through OKX" architecture slide

---

## Build Order (dependency-honest sequence)

1. Phase 0 (accounts block everything — start API key applications day 1)
2. Phase 2 bot skeleton + Phase 3 scraper in parallel
3. Phase 4 scorer offline on Kaggle data
4. Phase 5 tailor → Phase 2 match-card UX wired end-to-end with fake approvals
5. Phase 6 executor (email path only for MVP)
6. Phase 1 OKX integration (endpoint + registration + one listing + x402) — needs the product loop working to have something to sell
7. Phase 7 digest/delivery → Phase 8 hardening → Phase 9 demo

## Out of Scope (v2 — do not build now)

- Interview scheduling, salary negotiation drafting, multi-user/team profiles
- Workday/Lever form-fill adapters (Greenhouse only if time allows)
- Rubric auto-tuning from response data (log the inputs now, build later)
