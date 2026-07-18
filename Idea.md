# Legwork — Your Job Search, Run From Telegram powered by okx
### An Agent Service Provider for OKX AI — Resume & Career Workflows

---

## 1. Problem Statement

Job hunting at volume is a part-time job in itself. For anyone applying broadly — early-career candidates, career switchers, or anyone in a competitive market — the actual bottleneck isn't finding job postings, it's the repetitive grind of: find a posting, read it, decide if it's worth your time, tailor a resume, write a cover letter, fill out the application form (often on 3 different ATS platforms with 3 different UIs), and track what you've applied to.

Existing tools solve fragments of this: job aggregators find postings, resume tools optimize a single resume, but nothing closes the loop end to end — and nothing does it inside a chat interface people already check daily.

**Legwork** turns job hunting into a five-minute-a-day habit: the agent scans postings, scores them against your real profile, drafts a tailored application, and applies the moment you approve — all in a Telegram thread.

---

## 2. Why This Fits OKX AI's Marketplace

| OKX ASP Criterion | How Legwork Delivers |
|---|---|
| Clear utility | Removes hours/week of manual searching, tailoring, and form-filling |
| Real-world workflow | Full loop: discovery → scoring → tailoring → owner approval → submission → tracking |
| Category fit | Directly addresses Resume & Career Workflows — "move from application to opportunity faster" |
| Scale potential | Same pattern works across industries and seniority levels — the scoring rubric is a config, not a rebuild |
| Trust-first execution | No black-box "94% match" — every score and every application is shown before it's sent |

---

## 3. Core Design Principle: The Trust Loop

Fully autonomous applying is a liability, not a feature — nobody wants an agent silently submitting 40 applications with their name on it. Legwork keeps a human in the loop at the one step that matters:

1. **Agent finds + scores** — pulls new postings, scores each against the user's real profile
2. **Agent drafts** — tailored resume/cover letter for postings above the user's threshold
3. **Owner approves** — sees the score breakdown and the draft, taps approve or skip, per posting
4. **Agent executes** — submits the application only after approval, then tracks status

The pitch to the user: "It found 3 strong matches overnight and drafted applications you can approve in 30 seconds each" — not "it applied while you slept."

---

## 4. MVP Skill Set (4 skills for the hackathon build)

| Skill | What it does |
|---|---|
| **job-scraper** | Pulls new postings from a defined set of sources (job boards / company career pages) on a schedule |
| **match-scorer** | Scores each posting against the user's profile on a defined rubric: skills match, comp range, location/remote fit, seniority match, culture signals from the posting text |
| **application-tailor** | Drafts a resume variant and cover letter tailored to the specific posting, keyed to the ATS style if detectable (Workday, Greenhouse, Lever, etc.) |
| **apply-executor** | Fills and submits the application only after owner approval; logs the submission and tracks status changes where visible |

Out of scope for the hackathon build (v2 roadmap): interview scheduling, salary negotiation drafting, multi-user/team profiles.

---

## 5. Architecture

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
Weekly: owner digest — applications sent, response rate, top-scoring postings skipped
```

Every arrow is a point where the owner can say no or adjust the rubric.

---

## 6. Demo Script (for judges, ~4 minutes)

1. **Set the stakes (30s):** "Applying to jobs at volume is a part-time job. The bottleneck isn't finding postings — it's the repetitive tailoring and form-filling nobody has time for."
2. **Live flow (2 min):**
   - Show the agent pulling in 2–3 real postings live
   - Show the score breakdown for one posting — skills match, comp fit, seniority fit, called out explicitly, not a black box
   - Show the tailored resume/cover letter draft generated for that posting
   - Tap approve on stage — show the actual application being submitted
3. **The payoff (1 min):** Pull up the weekly digest — applications sent, postings skipped and why, response tracking — all generated automatically from the same loop
4. **Close (30s):** "This isn't a resume optimizer. It's the whole job search, running in the background, with you approving the one decision that actually matters — whether to apply."

---

## 7. Differentiators vs. Existing Tools

- Resume optimizers stop at the document. Legwork closes the loop to actual submission.
- Job aggregators surface postings but leave all the tailoring and filling to the user. Legwork does the work, not just the discovery.
- "Auto-apply" tools that exist today tend to spam low-quality applications with no scoring transparency — Legwork's rubric-based scoring and per-posting approval is the trust mechanism that makes it usable daily rather than something people turn off after a week.

---

## 8. Who It's For

**Primary:** Active job seekers doing high-volume applications — early-career candidates, career switchers, or anyone applying broadly in a competitive market — who currently spend hours per week on the find → tailor → fill grind.

**Not the target (for now):** Passive browsers or executives applying to 1–2 highly bespoke roles a month — the volume-based value proposition doesn't land for them.

---

## 9. Stretch Goals (if time allows)

- ATS-specific form-filling adapters for the top 3–5 platforms (Workday, Greenhouse, Lever)
- Interview prep card generated automatically once a status change to "interview" is detected
- Rubric auto-tuning based on which approved applications actually got responses







That's a strong idea — it actually maps cleanly onto OKX's Resume & Career Workflows category (which the other ideas didn't), and it has a much stronger "wow" demo moment than most career tools because the loop is fully closed: find → match → apply, not just "here's a rewritten resume, good luck."
Let me push on it a bit, because there's a real version of this and a version that gets ignored or distrusted.
What makes this good:

The current market is full of "resume optimizer" and "job aggregator" tools. Almost none of them close the loop to actual application. That's the gap OKX explicitly called out in category 2 — "move from application to opportunity faster." An agent that applies rather than advises is a genuinely different product.
Telegram as the interface is smart for the same reason it worked in the Mom-n-Pop repo: no new app, no dashboard, just chat — and it's a natural fit with OKX's chat-native ASP model.
It's demoable in a very visceral way: show a real job posting, the agent explaining why it's a fit, and a real application going out — that's a strong stage moment.

Where the real risk is — and it's the same one that killed the "generic small business" version of the last idea: too broad, no trust mechanism.
"Applies for you, all by chatting" raises an immediate credibility question for anyone watching: how do I know it's not spamming employers with garbage applications, or lying on my behalf, or applying to jobs I'd hate? That's the thing to solve, not paper over. Two fixes, both borrowed from what already worked in your other concept:

Keep the owner-approval loop. Agent finds a match, drafts the tailored resume/cover letter, shows you why it's a fit and what it's about to submit, you tap approve, then it applies. Fully autonomous applying is a scary pitch to judges and users alike ("it applied to 40 jobs while I was asleep" is a horror story, not a feature). "It found 3 great matches overnight and drafted applications for me to approve in 30 seconds each" is the winning framing.
Narrow the fit criteria to something defensible, not vague "best fit." "Best fit" is doing a lot of work — best fit by what measure? Give the agent a real scoring rubric: skills match, comp range, location/remote fit, seniority match, culture signals from the posting. Show that scoring in the chat, not just a black-box "94% match."

Sharper one-line pitch:

An agent that hunts job boards for you, scores every posting against your actual profile, drafts a tailored application, and applies the moment you tap approve — all inside Telegram, so job hunting becomes a five-minute-a-day habit instead of a part-time job.

Who it's for:
Active job seekers doing high-volume applications (early-career, career switchers, or anyone applying broadly) who currently burn hours per week on the "find posting → tailor resume → fill out application form" grind — not passive browsers, not executives doing 2 applications a month.
If you want, I can rewrite the submission doc format for this one — problem statement, MVP skill set (job-scraper, match-scorer, resume-tailor, apply-executor, owner-approval), architecture diagram, and a demo script built around a live application going out on stage.yes do thisOrchestrated document creation using markdown formattingOrchestrated document creation using markdown formattingSame structure as before, built around the approve-before-apply trust mechanism and a demo script with a real application going out live on stage.
Want me to also sketch the match-scorer rubric (the actual scoring logic — weights for skills, comp, location, seniority) so you have something concrete to start coding against?Legwork submissionDocument · MD are there public datas to see job postings and everything?Curated actionable job data sources, distinguishing free APIs from paid optionsCurated actionable job data sources, distinguishing free APIs from paid optionsYes — for a hackathon build, you want the free/self-serve ones, not the enterprise data vendors. Here's the breakdown:
Free, self-serve APIs (best for your build)

Adzuna API — free tier, aggregates postings across 16 countries, includes salary data and search filters. Adzuna's free API tier includes derived-data endpoints for 16 countries. Good starting point for a live demo since it's real-time and easy to query. JobsPipe
USAJOBS API — completely free, official US federal government job board. It's the cleanest fully free longitudinal option, with structured salary on every record, though scoped to federal jobs only. Great if you want a reliable, clean demo dataset even if it's a narrow vertical. JobsPipe
RemoteOK / Remotive / Arbeitnow — smaller free/open APIs commonly used in hackathons for remote job listings, no auth or cheap auth, good for a quick demo pull.
Public APIs directory (publicapis.dev/category/jobs) lists ~22 job-related APIs including international postings, company profiles, and aggregation across LinkedIn, Glassdoor, Indeed, and 16+ other sites — worth scanning for one with a generous free tier. Public APIs

Static datasets (good for prototyping the match-scorer without hitting live rate limits)

Kaggle — the LinkedIn job postings dataset (roughly 124,000 postings with salary, company, and skill fields) is the most cited, alongside Indeed and Glassdoor scrapes. Free, instant download, frozen snapshot — perfect for building and testing your scoring rubric before wiring up a live feed. JobsPipe

Paid/enterprise-grade (skip these for the hackathon, but worth knowing exist if this becomes a real product)

Coresignal, Techmap, Lightcast, Bright Data — these offer hundreds of millions of records with real-time updates, but require paid plans or demos, not worth the setup time for a weekend build.

Recommendation for your build:
Start with the Kaggle LinkedIn dataset to build and test match-scorer offline (no rate limits, no API keys to manage during dev), then wire up Adzuna's free API for the live demo since it's real-time, has a real key you can get in minutes, and covers enough breadth to look credible on stage. Skip building a custom scraper — that's the exact burden APIs and ready-made datasets exist to remove. Proxyway
Want me to pull the actual API docs for Adzuna and USAJOBS and sketch the request/response shape you'd wire into the job-scraper skill?how do I allow the agent send everything for melike it has access to my mail and send on my behalfwhat tool should I useEvaluated email API options and delegated access mechanismsEvaluated email API options and delegated access mechanismsFor the "send on your behalf" piece, you're looking at an email API with OAuth delegated access — the agent authenticates as you (with your consent) and can then send/read within the scopes you grant. Here's what's actually available:
Gmail API (most common choice)

OAuth 2.0 flow: you authorize the app once, it gets a refresh token, and can send/read mail without you being present for each action
Scopes matter a lot here — gmail.send lets it send but not read your inbox; gmail.readonly lets it read but not send; gmail.modify is broader. For Legwork you'd likely want gmail.send + maybe gmail.readonly to check application status replies, not full inbox access.
Well documented, free tier is generous, this is what most hackathon projects use.

Microsoft Graph API (if targeting Outlook/M365 users)

Same idea — OAuth delegated permissions, Mail.Send and Mail.Read scopes
More setup overhead (Azure AD app registration) than Gmail, only worth it if your users are on Outlook specifically

Simpler alternative: transactional email service (SendGrid, Postmark, Resend)

These send from an address you control (like a Legwork-branded address or a verified sender), not literally from the user's own Gmail
Much simpler to wire up, no OAuth dance, but the email won't come from the user's actual inbox — for job applications this matters, since employers often expect to reply to the applicant's real email
Good for internal notifications (e.g., agent → owner Telegram alerts) but weaker for the actual outbound application email

For Legwork specifically: Gmail API with gmail.send scope is the right call — the application needs to come from the person's real email address so replies land in their real inbox.
One thing worth building in regardless of which you pick, and this matters a lot given what you already designed into the trust loop: don't give the agent standing "send whatever it wants, whenever" access. Set it up so:

The OAuth scope is as narrow as possible (send not full inbox access)
The agent drafts the email and shows you the actual content before it fires — this is the same approve-then-execute pattern you already built into the estimator/payment flow, and it's the reason people would trust this daily instead of turning it off after one bad autosend
You can revoke access anytime from your Google account's connected apps settings

Want me to walk through the actual Gmail API OAuth setup (Google Cloud Console steps, scopes, token flow) so you can wire this into the apply-executor skill?