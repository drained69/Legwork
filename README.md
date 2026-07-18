# Legwork

**Your job search, run from Telegram — powered by OKX AI.**

Legwork is an Agent Service Provider (ASP) for the OKX AI marketplace, built for
**Resume & Career Workflows**. It turns high-volume job hunting from a part-time
job into a five-minute-a-day habit: the agent scans postings, scores each against
your real profile, drafts a tailored application, and applies the moment you tap
approve — all inside a Telegram thread.

> One-line pitch: an agent that hunts job boards for you, scores every posting
> against your actual profile, drafts a tailored application, and applies the
> moment you approve — so job hunting becomes a five-minute-a-day habit instead
> of a part-time job.

---

## Table of Contents

- [The Problem](#the-problem)
- [How Legwork Works](#how-legwork-works)
- [The Trust Loop](#the-trust-loop)
- [Skills (MVP)](#skills-mvp)
- [Architecture](#architecture)
- [Data Sources](#data-sources)
- [Email / Sending on Your Behalf](#email--sending-on-your-behalf)
- [Differentiators](#differentiators)
- [Who It's For](#who-its-for)
- [Roadmap](#roadmap)
- [Demo Script](#demo-script)

---

## The Problem

Applying to jobs at volume is a job in itself. The bottleneck isn't finding
postings — it's the repetitive grind of reading a posting, deciding if it's worth
your time, tailoring a resume, writing a cover letter, filling out a form on yet
another ATS, and tracking what you've applied to.

Existing tools solve only fragments: aggregators find postings, resume tools
optimize a single document — but nothing closes the loop end to end, and nothing
does it inside a chat interface people already check daily.

## How Legwork Works

1. **Find + score** — pulls new postings and scores each against your real profile.
2. **Draft** — writes a tailored resume variant and cover letter for postings above your threshold.
3. **Approve** — you see the score breakdown and the draft, then tap approve or skip, per posting.
4. **Execute** — Legwork submits only after approval, then tracks status.

## The Trust Loop

Fully autonomous applying is a liability, not a feature — nobody wants an agent
silently submitting 40 applications with their name on it. Legwork keeps a human
in the loop at the one step that matters: **approval before submission.**

- Every score is explained (skills, comp, location, seniority) — no black-box "94% match".
- Every application is shown in full before it's sent.
- Access can be revoked at any time.

The framing: *"It found 3 strong matches overnight and drafted applications you
can approve in 30 seconds each"* — not *"it applied while you slept."*

## Skills (MVP)

| Skill | What it does |
|---|---|
| **job-scraper** | Pulls new postings from a defined set of sources (job boards / company career pages) on a schedule |
| **match-scorer** | Scores each posting against the user's profile on a rubric: skills match, comp range, location/remote fit, seniority match, culture signals |
| **application-tailor** | Drafts a resume variant and cover letter tailored to the posting, keyed to the ATS style if detectable (Workday, Greenhouse, Lever, etc.) |
| **apply-executor** | Fills and submits the application only after owner approval; logs the submission and tracks status changes |

## Architecture

```
Job source scan (scheduled)
        ↓
Agent scores each new posting (match-scorer)
        ↓
Postings above threshold → agent drafts tailored resume + cover letter
        ↓
Agent sends card to owner in Telegram: score breakdown + draft preview
        ↓
Owner approves (tap) or skips
        ↓
Agent submits application (apply-executor)
        ↓
Agent logs submission, tracks status
        ↓
Weekly: owner digest — applications sent, response rate, top-scoring skips
```

Every arrow is a point where the owner can say no or adjust the rubric.

## Data Sources

For a hackathon build, use free / self-serve sources rather than enterprise data vendors.

**Free, self-serve APIs (best for live demo):**

- **Adzuna API** — free tier, 16 countries, includes salary data and search filters; real-time and easy to query.
- **USAJOBS API** — completely free, official US federal board; clean structured salary on every record (federal scope only).
- **RemoteOK / Remotive / Arbeitnow** — small free/open APIs for remote listings, minimal auth.
- **publicapis.dev/category/jobs** — directory of ~22 job-related APIs worth scanning for generous free tiers.

**Static datasets (best for prototyping the match-scorer offline):**

- **Kaggle — LinkedIn job postings dataset** (~124k postings with salary, company, and skill fields) — frozen snapshot, no rate limits, ideal for building/testing the scoring rubric.

**Enterprise (out of scope for the hackathon):** Coresignal, Techmap, Lightcast, Bright Data.

**Recommended path:** build and test `match-scorer` offline on the Kaggle dataset, then wire up Adzuna's free API for the live demo.

## Email / Sending on Your Behalf

To send applications from your real address, use an email API with OAuth delegated access.

- **Gmail API (recommended)** — OAuth 2.0 flow; request the narrowest scope: `gmail.send` (send only), optionally `gmail.readonly` to track reply status. Applications come from the user's real inbox so replies land where employers expect.
- **Microsoft Graph API** — for Outlook/M365 users; `Mail.Send` / `Mail.Read` scopes, with more setup overhead (Azure AD app registration).
- **Transactional services (SendGrid, Postmark, Resend)** — simplest to wire up, but send from an address you control rather than the user's inbox. Best for internal notifications (agent → owner alerts), weaker for outbound applications.

**Guardrails (regardless of provider):**

- Use the narrowest OAuth scope possible (send, not full inbox access).
- The agent drafts the email and shows the content before it fires (approve-then-execute).
- Access is revocable anytime from the user's connected-apps settings.

## Differentiators

- Resume optimizers stop at the document. Legwork closes the loop to actual submission.
- Job aggregators surface postings but leave the tailoring and filling to the user. Legwork does the work, not just the discovery.
- "Auto-apply" tools today spam low-quality applications with no scoring transparency. Legwork's rubric-based scoring and per-posting approval is the trust mechanism that makes it usable daily.

## Who It's For

**Primary:** Active job seekers doing high-volume applications — early-career
candidates, career switchers, or anyone applying broadly in a competitive market
— who currently spend hours per week on the find → tailor → fill grind.

**Not the target (for now):** Passive browsers or executives applying to 1–2
highly bespoke roles a month.

## Roadmap

- ATS-specific form-filling adapters for the top platforms (Workday, Greenhouse, Lever).
- Interview prep card generated automatically when a status changes to "interview".
- Rubric auto-tuning based on which approved applications actually got responses.
- (v2) Interview scheduling, salary negotiation drafting, multi-user/team profiles.

## Demo Script

_(~4 minutes, for judges)_

1. **Set the stakes (30s):** Applying at volume is a part-time job — the bottleneck is the repetitive tailoring and form-filling.
2. **Live flow (2 min):** show the agent pulling 2–3 real postings, the explicit score breakdown for one, the tailored draft, then tap approve on stage and show the application being submitted.
3. **The payoff (1 min):** pull up the weekly digest — applications sent, postings skipped and why, response tracking — all generated from the same loop.
4. **Close (30s):** "This isn't a resume optimizer. It's the whole job search, running in the background, with you approving the one decision that actually matters — whether to apply."
