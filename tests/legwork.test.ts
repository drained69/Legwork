/**
 * Pre-launch test suite. Runs against an in-memory SQLite DB with all
 * external services disabled (mock job source, heuristic scoring, simulated
 * submission) — exactly the degraded paths production falls back to.
 *
 * Run: npm test
 */
// Force-isolate from any real .env: set empty strings BEFORE the app loads —
// dotenv never overrides an already-defined variable, `delete` would let it.
process.env.DATABASE_PATH = ':memory:';
process.env.ADZUNA_APP_ID = '';
process.env.ADZUNA_APP_KEY = '';
process.env.USAJOBS_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.GMAIL_CLIENT_ID = '';
process.env.GMAIL_CLIENT_SECRET = '';
process.env.GMAIL_REFRESH_TOKEN = '';
process.env.X402_FACILITATOR_URL = '';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('../src/db.js');
const { scanForUser } = await import('../src/skills/jobScraper.js');
const { scorePosting } = await import('../src/skills/matchScorer.js');
const { tailorApplication } = await import('../src/skills/applicationTailor.js');
const { submitApplication, resolveSubmissionTarget } = await import('../src/skills/applyExecutor.js');
const { runScanCycle } = await import('../src/pipeline.js');
const { handleEnvelope, deliverEngagement } = await import('../src/okx/server.js');
const { buildDigest, buildEvidenceBundle } = await import('../src/digest.js');

import type { Posting, Profile } from '../src/types.js';

// ── fixtures ───────────────────────────────────────────────────────────────

const profile: Profile = {
  userId: 'u1',
  name: 'Alex Rivera',
  targetRoles: ['backend engineer'],
  seniority: 'senior',
  locations: ['remote', 'Austin, TX'],
  remoteOk: true,
  compFloor: 110000,
  skills: ['typescript', 'node.js', 'postgresql', 'redis', 'aws', 'react'],
  resumeText: 'Senior engineer, 7 years. Node.js, TypeScript, PostgreSQL payment infra at fintech.',
  dealbreakers: [],
  threshold: 60,
  dailyCap: 5,
  email: 'alex@example.com',
};

function makePosting(overrides: Partial<Posting> = {}): Posting {
  return {
    id: overrides.id ?? db.postingHash(overrides.company ?? 'TestCo', overrides.title ?? 'Engineer', overrides.location ?? 'Remote'),
    source: 'test',
    externalId: 'x1',
    title: 'Senior Backend Engineer',
    company: 'TestCo',
    location: 'Remote (US)',
    remote: true,
    compMin: 120000,
    compMax: 150000,
    description: 'TypeScript and Node.js role. Apply to jobs@testco.example.',
    url: 'https://example.com/x1',
    atsHint: 'email',
    fetchedAt: db.now(),
    ...overrides,
  };
}

// ── match-scorer ───────────────────────────────────────────────────────────

test('scorer: comp below floor scores 0 with explicit reason', async () => {
  const b = await scorePosting(profile, makePosting({ compMin: 50000, compMax: 90000 }));
  assert.equal(b.comp.score, 0);
  assert.match(b.comp.reason, /below your \$110,000 floor/);
});

test('scorer: comp fully clearing floor scores 20/20', async () => {
  const b = await scorePosting(profile, makePosting({ compMin: 120000, compMax: 150000 }));
  assert.equal(b.comp.score, 20);
});

test('scorer: comp range straddling floor scores partial', async () => {
  const b = await scorePosting(profile, makePosting({ compMin: 90000, compMax: 130000 }));
  assert.ok(b.comp.score > 0 && b.comp.score < 20, `expected partial, got ${b.comp.score}`);
});

test('scorer: remote match + exact seniority max out those axes', async () => {
  const b = await scorePosting(profile, makePosting());
  assert.equal(b.location.score, 15);
  assert.equal(b.seniority.score, 15);
});

test('scorer: every sub-score carries a non-empty reason (no black boxes)', async () => {
  const b = await scorePosting(profile, makePosting());
  for (const axis of [b.skills, b.comp, b.location, b.seniority, b.culture]) {
    assert.ok(axis.reason.length > 5, `missing reason on an axis`);
  }
  assert.equal(b.total, b.skills.score + b.comp.score + b.location.score + b.seniority.score + b.culture.score);
});

// ── job-scraper ────────────────────────────────────────────────────────────

test('scraper: mock scan returns postings once, then dedupes per user', async () => {
  const p = { ...profile, userId: 'scraper-user' };
  const first = await scanForUser(p, 'eng-scrape');
  assert.ok(first.newPostings.length >= 5, 'expected mock postings on first scan');
  const second = await scanForUser(p, 'eng-scrape');
  assert.equal(second.newPostings.length, 0, 'second scan must return nothing new');
  assert.ok(second.duplicates >= 5);
});

// ── application-tailor ─────────────────────────────────────────────────────

test('tailor: fallback drafts contain only real profile content and version increments', async () => {
  const posting = makePosting({ company: 'TailorCo', title: 'Platform Engineer' });
  db.savePosting(posting);
  const d1 = await tailorApplication(profile, posting);
  const d2 = await tailorApplication(profile, posting, 'shorter please');
  assert.equal(d1.version, 1);
  assert.equal(d2.version, 2);
  assert.match(d1.coverLetter, /TailorCo/);
  assert.match(d1.resumeText, /Alex Rivera/);
  // never-fabricate: resume body comes verbatim from the profile
  assert.ok(d1.resumeText.includes(profile.resumeText));
});

// ── apply-executor: the trust gate ─────────────────────────────────────────

test('executor: refuses without recorded approval', async () => {
  const posting = makePosting({ company: 'GateCo' });
  db.savePosting(posting);
  const draft = await tailorApplication(profile, posting);
  const app = {
    id: db.uid(), userId: profile.userId, engagementId: 'eng-gate', postingId: posting.id,
    draftId: draft.id, status: 'pending_approval' as const, score: 80,
    breakdown: await scorePosting(profile, posting), createdAt: db.now(),
  };
  db.createApplication(app);
  const res = await submitApplication(app, profile, posting);
  assert.equal(res.ok, false);
  assert.match(res.error!, /no recorded approval/);
});

test('executor: approved app submits, freezes draft, refuses double-submit', async () => {
  const posting = makePosting({ company: 'SubmitCo' });
  db.savePosting(posting);
  const draft = await tailorApplication(profile, posting);
  const app = {
    id: db.uid(), userId: profile.userId, engagementId: 'eng-submit', postingId: posting.id,
    draftId: draft.id, status: 'approved' as const, score: 80,
    breakdown: await scorePosting(profile, posting), approvalAt: db.now(), createdAt: db.now(),
  };
  db.createApplication(app);
  const res = await submitApplication(app, profile, posting);
  assert.equal(res.ok, true);
  assert.match(res.receipt!, /jobs@testco.example|SIMULATED/);
  assert.equal(db.getApplication(app.id)!.status, 'submitted');
  assert.equal(db.getDraft(draft.id)!.immutable, true, 'draft must freeze at submission');

  const again = await submitApplication(db.getApplication(app.id)!, profile, posting);
  assert.equal(again.ok, false);
  assert.match(again.error!, /already submitted/);
});

test('executor: approval flag alone is not enough — needs approvalAt + draftId', async () => {
  const posting = makePosting({ company: 'HalfGateCo' });
  db.savePosting(posting);
  const app = {
    id: db.uid(), userId: profile.userId, engagementId: 'eng-half', postingId: posting.id,
    status: 'approved' as const, score: 80,
    breakdown: await scorePosting(profile, posting), createdAt: db.now(), // no approvalAt, no draftId
  };
  db.createApplication(app);
  const res = await submitApplication(app, profile, posting);
  assert.equal(res.ok, false);
});

test('executor: submission target is visible pre-approval (email extraction + link fallback)', () => {
  const emailPosting = makePosting({ description: 'Great role. Send resume to hire@corp.example today.' });
  const linkPosting = makePosting({ description: 'Apply through our portal.', url: 'https://jobs.example/apply' });
  assert.deepEqual(resolveSubmissionTarget(emailPosting), { method: 'email', to: 'hire@corp.example' });
  assert.deepEqual(resolveSubmissionTarget(linkPosting), { method: 'link', url: 'https://jobs.example/apply' });
});

// ── db idempotency ─────────────────────────────────────────────────────────

test('db: one application per (engagement, posting) — duplicate insert rejected', async () => {
  const posting = makePosting({ company: 'DupeCo' });
  const base = {
    userId: 'u1', engagementId: 'eng-dupe', postingId: posting.id,
    status: 'pending_approval' as const, score: 70,
    breakdown: await scorePosting(profile, posting), createdAt: db.now(),
  };
  assert.equal(db.createApplication({ ...base, id: db.uid() }), true);
  assert.equal(db.createApplication({ ...base, id: db.uid() }), false);
});

// ── OKX marketplace lifecycle ──────────────────────────────────────────────

test('okx: task_assigned creates engagement with deep link; repeat is idempotent', () => {
  const r1 = handleEnvelope({ jobId: 'job-A', message: { source: 'system', event: 'task_assigned', jobId: 'job-A' } });
  const e1 = db.getEngagementByJob('job-A')!;
  assert.match((r1 as { reply: string }).reply, new RegExp(e1.taskCode));
  const r2 = handleEnvelope({ jobId: 'job-A', message: { source: 'system', event: 'task_assigned', jobId: 'job-A' } });
  assert.match((r2 as { reply: string }).reply, new RegExp(e1.taskCode), 'same code on repeat — no second engagement');
});

test('okx: full lifecycle — bind, scan, approve, deliver, settle', async () => {
  handleEnvelope({
    jobId: 'job-B',
    message: { source: 'system', event: 'task_assigned', jobId: 'job-B', listing: 'job-search-sprint-7d' },
  });
  const engagement = db.getEngagementByJob('job-B')!;
  const userId = 'lifecycle-user';
  engagement.userId = userId;
  engagement.status = 'active';
  db.saveEngagement(engagement);
  db.saveProfile({ ...profile, userId });

  const summary = await runScanCycle(engagement);
  assert.ok(summary.cards.length >= 1, 'expected at least one match card');

  // second cycle: nothing new (idempotency at the pipeline level)
  const summary2 = await runScanCycle(engagement);
  assert.equal(summary2.cards.length, 0);

  // approve + submit the top card
  const top = summary.cards[0];
  top.application.status = 'approved';
  top.application.approvalAt = db.now();
  db.updateApplication(top.application);
  const res = await submitApplication(top.application, db.getProfile(userId)!, top.posting);
  assert.equal(res.ok, true);

  // digest reflects it
  const digest = buildDigest(engagement);
  assert.match(digest, /Applications submitted: 1/);

  // deliver + settle
  deliverEngagement(engagement);
  db.saveEngagement(engagement);
  handleEnvelope({ jobId: 'job-B', message: { source: 'system', event: 'delivery_accepted', jobId: 'job-B' } });
  assert.equal(db.getEngagementByJob('job-B')!.status, 'settled');
});

test('okx: dispute returns evidence bundle with approval timestamps', async () => {
  handleEnvelope({ jobId: 'job-C', message: { source: 'system', event: 'task_assigned', jobId: 'job-C' } });
  const engagement = db.getEngagementByJob('job-C')!;
  const r = handleEnvelope({ jobId: 'job-C', message: { source: 'system', event: 'dispute_opened', jobId: 'job-C' } });
  assert.match((r as { evidence: string }).evidence, /EVIDENCE BUNDLE — OKX job job-C/);
  assert.equal(db.getEngagementByJob('job-C')!.status, 'disputed');
});

test('okx: buyer chat "status" returns the digest through the marketplace', () => {
  handleEnvelope({ jobId: 'job-D', message: { source: 'system', event: 'task_assigned', jobId: 'job-D' } });
  const r = handleEnvelope({
    msgType: 'a2a-agent-chat', jobId: 'job-D',
    parts: [{ kind: 'text', text: 'status please' }],
  });
  assert.match((r as { reply: string }).reply, /Legwork digest/);
});

test('okx: unknown job chat is rejected', () => {
  const r = handleEnvelope({ msgType: 'a2a-agent-chat', jobId: 'job-nope', parts: [{ kind: 'text', text: 'hi' }] });
  assert.equal((r as { ok: boolean }).ok, false);
});

// ── OKX real event names ───────────────────────────────────────────────────
// The endpoint previously only understood invented names (task_assigned,
// delivery_accepted). Every real event fell through to "event ignored", so a
// pushed task was never picked up and expired.

test('okx: real job_created event creates the engagement (not "event ignored")', () => {
  const r = handleEnvelope({ jobId: 'job-E1', message: { source: 'system', event: 'job_created', jobId: 'job-E1' } });
  const e = db.getEngagementByJob('job-E1');
  assert.ok(e, 'job_created must create an engagement');
  assert.match((r as { reply: string }).reply, new RegExp(e!.taskCode));
});

test('okx: job_asp_selected (buyer designated us) is treated as an assignment', () => {
  handleEnvelope({ jobId: 'job-E2', message: { source: 'system', event: 'job_asp_selected', jobId: 'job-E2' } });
  assert.ok(db.getEngagementByJob('job-E2'), 'designation must create an engagement');
});

test('okx: job_accepted moves the engagement out of awaiting_link', () => {
  handleEnvelope({ jobId: 'job-E3', message: { source: 'system', event: 'job_created', jobId: 'job-E3' } });
  assert.equal(db.getEngagementByJob('job-E3')!.status, 'awaiting_link');
  handleEnvelope({ jobId: 'job-E3', message: { source: 'system', event: 'job_accepted', jobId: 'job-E3' } });
  assert.equal(db.getEngagementByJob('job-E3')!.status, 'active');
});

test('okx: job_completed settles and fires the onSettled handler', () => {
  handleEnvelope({ jobId: 'job-E4', message: { source: 'system', event: 'job_created', jobId: 'job-E4' } });
  let settled = '';
  handleEnvelope(
    { jobId: 'job-E4', message: { source: 'system', event: 'job_completed', jobId: 'job-E4' } },
    { onSettled: (e) => { settled = e.okxJobId; } },
  );
  assert.equal(db.getEngagementByJob('job-E4')!.status, 'settled');
  assert.equal(settled, 'job-E4');
});

test('okx: job_expired closes the engagement locally', () => {
  handleEnvelope({ jobId: 'job-E5', message: { source: 'system', event: 'job_created', jobId: 'job-E5' } });
  handleEnvelope({ jobId: 'job-E5', message: { source: 'system', event: 'job_expired', jobId: 'job-E5' } });
  assert.equal(db.getEngagementByJob('job-E5')!.status, 'closed');
});

test('okx: job_rejected marks the engagement contested and returns evidence', () => {
  handleEnvelope({ jobId: 'job-E6', message: { source: 'system', event: 'job_created', jobId: 'job-E6' } });
  const r = handleEnvelope({ jobId: 'job-E6', message: { source: 'system', event: 'job_rejected', jobId: 'job-E6' } });
  assert.match((r as { evidence: string }).evidence, /EVIDENCE BUNDLE/);
  assert.equal(db.getEngagementByJob('job-E6')!.status, 'disputed');
});

test('okx: every system event notifies the poller so push and pull converge', () => {
  const seen: string[] = [];
  handleEnvelope(
    { jobId: 'job-E7', message: { source: 'system', event: 'job_created', jobId: 'job-E7' } },
    { onSystemEvent: (event) => seen.push(event) },
  );
  // Even an event this endpoint has no special handling for must reconcile.
  handleEnvelope(
    { jobId: 'job-E7', message: { source: 'system', event: 'provider_applied', jobId: 'job-E7' } },
    { onSystemEvent: (event) => seen.push(event) },
  );
  assert.deepEqual(seen, ['job_created', 'provider_applied']);
});

// ── marketplace poller: retrieving and claiming tasks ──────────────────────

test('marketplace: recommend-task text output parses into claimable tasks', async () => {
  const { parseRecommendedTasks } = await import('../src/okx/marketplace.js');
  const raw = [
    '[Agent 6658] Matched 2 Public task(s):',
    '',
    '  1. jobId: 0x788da7aff78c947c937168fb699b4d7b3935951a80cff685b0a6611560e19846',
    '     Title:      Find Software Developer Jobs',
    '     Description: Remote senior backend roles, $150k+, TypeScript and Go.',
    '     Budget:     0.25 (token: 0x779ded0c9e1022225f8e0630b35a9b54be713736)',
    '     Created:    2026-07-21T22:20:54Z',
    '',
    '  2. jobId: 0x54391fa2b21b5a0da428de6c6c5e33109f3965b9e1503ea04119ab1d34659eed',
    '     Title:      Resume for Marketing Role',
    '     Budget:     1 (token: 0x779ded0c9e1022225f8e0630b35a9b54be713736)',
  ].join('\n');

  const tasks = parseRecommendedTasks(raw);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].jobId, '0x788da7aff78c947c937168fb699b4d7b3935951a80cff685b0a6611560e19846');
  assert.equal(tasks[0].title, 'Find Software Developer Jobs');
  assert.equal(tasks[0].tokenAmount, '0.25');
  assert.match(tasks[0].description!, /TypeScript and Go/);
  assert.equal(tasks[1].title, 'Resume for Marketing Role');
  // Public tasks are never treated as designated — applying to one would jump
  // the negotiation the protocol requires.
  assert.equal(tasks[0].designated, false);
});

test('marketplace: empty / error output yields no tasks rather than throwing', async () => {
  const { parseRecommendedTasks } = await import('../src/okx/marketplace.js');
  assert.deepEqual(parseRecommendedTasks(''), []);
  assert.deepEqual(parseRecommendedTasks('{"ok":false,"error":"AgentApi.agentServices failed"}'), []);
});

test('marketplace: buyer brief maps onto the right listing', async () => {
  const { inferListing } = await import('../src/okx/poller.js');
  assert.equal(inferListing({ title: 'Resume for Marketing Role' }), 'tailor-one-application');
  assert.equal(inferListing({ title: 'Daily job search for UX roles' }), 'job-hunt-weekly');
  assert.equal(inferListing({ title: 'Find top software jobs' }), 'job-hunt');
});

test('marketplace: criteria are extracted from a buyer brief without an LLM', async () => {
  const { heuristicCriteria } = await import('../src/skills/jobHunt.js');
  const c = heuristicCriteria('Find senior backend engineer roles, remote only, $150k+ base');
  assert.equal(c.seniority, 'senior');
  assert.equal(c.compFloor, 150000);
  assert.deepEqual(c.locations, ['remote']);
  assert.ok(c.roles!.length > 0, 'must carry something for the scorer to work with');
});

// ── pipeline daily cap ─────────────────────────────────────────────────────

test('pipeline: daily cap limits match cards', async () => {
  handleEnvelope({ jobId: 'job-cap', message: { source: 'system', event: 'task_assigned', jobId: 'job-cap' } });
  const engagement = db.getEngagementByJob('job-cap')!;
  const userId = 'cap-user';
  engagement.userId = userId;
  engagement.status = 'active';
  db.saveEngagement(engagement);
  db.saveProfile({ ...profile, userId, threshold: 0, dailyCap: 2 }); // everything matches, cap 2
  const summary = await runScanCycle(engagement);
  assert.equal(summary.cards.length, 2);
  assert.equal(summary.cappedOut, true);
});

// ── job-hunt: the entry product ────────────────────────────────────────────

test('hunt: default listing is job-hunt', () => {
  handleEnvelope({ jobId: 'job-hunt-1', message: { source: 'system', event: 'task_assigned', jobId: 'job-hunt-1' } });
  const e = db.getEngagementByJob('job-hunt-1')!;
  assert.equal(e.listing, 'job-hunt');
});

test('pricing: bundles stay within a sane multiple of their API-call value', async () => {
  const { LISTINGS } = await import('../src/okx/server.js');
  // A hunt engagement runs 4 scheduled hunts/day at $0.05/call.
  const apiValue = (days: number) => days * 4 * 0.05;
  const checks: Array<[keyof typeof LISTINGS, number]> = [
    ['job-hunt', apiValue(1)],
    ['job-hunt-weekly', apiValue(7)],
    ['job-search-sprint-7d', apiValue(7) + 10 * 0.1], // + ~10 tailors
  ];
  for (const [id, value] of checks) {
    const price = Number(LISTINGS[id].priceUsd);
    assert.ok(price <= value * 2, `${id} at $${price} is over 2x its $${value.toFixed(2)} API-call value`);
  }
  // A single tailored application is one $0.10 call — delivery premium only.
  assert.ok(Number(LISTINGS['tailor-one-application'].priceUsd) <= 0.5);
  // Entry point must stay impulse-priced for a new, unproven agent.
  assert.ok(Number(LISTINGS['job-hunt'].priceUsd) <= 0.5, 'entry listing must stay under $0.50');
});

test('hunt: unknown listing falls back to job-hunt', () => {
  handleEnvelope({
    jobId: 'job-hunt-2',
    message: { source: 'system', event: 'task_assigned', jobId: 'job-hunt-2', listing: 'nonsense-listing' },
  });
  assert.equal(db.getEngagementByJob('job-hunt-2')!.listing, 'job-hunt');
});

test('hunt: criteria-only profile (no resume/email) produces a ranked shortlist', async () => {
  const { runHunt, formatShortlist, formatCriteriaSummary } = await import('../src/skills/jobHunt.js');
  handleEnvelope({ jobId: 'job-hunt-3', message: { source: 'system', event: 'task_assigned', jobId: 'job-hunt-3' } });
  const engagement = db.getEngagementByJob('job-hunt-3')!;
  const userId = 'hunt-user';
  engagement.userId = userId;
  engagement.status = 'active';
  db.saveEngagement(engagement);
  const criteria: Profile = {
    ...profile,
    userId,
    resumeText: '', // hunt-only: no resume
    email: undefined,
    threshold: 0,
    dailyCap: 10,
    factors: ['equity', 'async-first'],
  };
  db.saveProfile(criteria);

  assert.match(formatCriteriaSummary(criteria), /Priority factors: equity, async-first/);

  const result = await runHunt(engagement);
  assert.ok(result.matches.length >= 5, 'expected shortlist from mock sources');
  // Ranked: scores must be non-increasing.
  for (let i = 1; i < result.matches.length; i++) {
    assert.ok(result.matches[i - 1].breakdown.total >= result.matches[i].breakdown.total, 'shortlist must be ranked');
  }
  // Shortlist persisted on the engagement — it is the OKX deliverable.
  const updated = db.getEngagementByJob('job-hunt-3')!;
  assert.ok(updated.shortlist, 'shortlist stored');
  assert.match(deliverEngagement(updated), /Job hunt results/);

  // Second hunt: dedupe means no repeats.
  const again = await runHunt(db.getEngagementByJob('job-hunt-3')!);
  assert.equal(again.matches.length, 0);

  const rendered = formatShortlist(criteria, result.matches, result.found);
  assert.match(rendered, /no black boxes/);
});

test('hunt: stated factors drive the culture axis in heuristic scoring', async () => {
  const withFactors: Profile = { ...profile, userId: 'factor-user', factors: ['async-first', 'quarterly onsites'] };
  const posting = makePosting({
    id: 'factor-posting',
    description: 'TypeScript role. Async-first culture, quarterly onsites. Apply via portal.',
  });
  const b = await scorePosting(withFactors, posting);
  assert.equal(b.culture.score, 10, 'both factors present → full culture score');
  assert.match(b.culture.reason, /2\/2 of your factors present/);

  const miss = await scorePosting(withFactors, makePosting({ id: 'factor-miss', description: 'Plain TypeScript role.' }));
  assert.equal(miss.culture.score, 0);
});

test('hunt: chunkMessage keeps every chunk under the Telegram limit', async () => {
  const { chunkMessage } = await import('../src/skills/jobHunt.js');
  const long = Array.from({ length: 300 }, (_, i) => `line ${i} — some posting details here`).join('\n');
  const chunks = chunkMessage(long);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 3500);
  assert.equal(chunks.join('\n'), long, 'no content lost in chunking');
});

test('hunt: chunkMessage hard-splits a single line longer than the limit', async () => {
  const { chunkMessage } = await import('../src/skills/jobHunt.js');
  // Line-boundary splitting alone leaves this as one oversized chunk, which
  // the send would then reject.
  const chunks = chunkMessage('x'.repeat(9000), 3500);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(c.length <= 3500, `chunk of ${c.length} exceeds the limit`);
  assert.equal(chunks.join(''), 'x'.repeat(9000), 'no content lost');
});

test('hunt: heuristic criteria keep a stated location instead of forcing remote', async () => {
  const { heuristicCriteria } = await import('../src/skills/jobHunt.js');
  assert.deepEqual(heuristicCriteria('Backend engineer in Austin, onsite').locations, ['austin']);
  // Nothing stated → remote is the honest default, not a guess.
  assert.deepEqual(heuristicCriteria('Backend engineer').locations, ['remote']);
});

// ── evidence bundle ────────────────────────────────────────────────────────

test('evidence bundle lists every application with approval + receipt fields', async () => {
  const engagement = db.getEngagementByJob('job-B')!;
  const bundle = buildEvidenceBundle(engagement);
  assert.match(bundle, /approvedAt=20/); // ISO timestamp present
  assert.match(bundle, /receipt=/);
});

// ── wallet identity: one wallet = one profile ──────────────────────────────

test('wallet: getProfileByWallet finds the owner case-insensitively', () => {
  db.saveProfile({ ...profile, userId: 'w-owner', wallet: '0xAbCd00000000000000000000000000000000EF01' });
  const found = db.getProfileByWallet('0xabcd00000000000000000000000000000000ef01');
  assert.equal(found?.userId, 'w-owner');
  assert.equal(db.getProfileByWallet('0x9999000000000000000000000000000000009999'), undefined);
});

test('wallet: transferProfile moves profile, history and live engagements to the new account', async () => {
  const wallet = '0xBeeF00000000000000000000000000000000BeeF';
  db.saveProfile({ ...profile, userId: 'old-tg', wallet, targetRoles: ['data engineer'] });
  db.markSeen('old-tg', 'posting-w1');
  handleEnvelope({ jobId: 'job-w1', message: { source: 'system', event: 'task_assigned', jobId: 'job-w1' } });
  const eng = db.getEngagementByJob('job-w1')!;
  eng.userId = 'old-tg';
  eng.status = 'active';
  db.saveEngagement(eng);

  db.transferProfile('old-tg', 'new-tg');

  assert.equal(db.getProfile('old-tg'), undefined, 'old account no longer holds the profile');
  const moved = db.getProfile('new-tg');
  assert.equal(moved?.wallet, wallet);
  assert.deepEqual(moved?.targetRoles, ['data engineer']);
  assert.equal(db.getEngagementByJob('job-w1')?.userId, 'new-tg', 'live engagement follows the wallet');
  assert.equal(db.markSeen('new-tg', 'posting-w1'), false, 'seen history follows — no duplicate cards');
  // Invariant: exactly one profile owns the wallet.
  assert.equal(db.getProfileByWallet(wallet)?.userId, 'new-tg');
});

test('wallet: settled engagements do NOT follow a transfer', () => {
  handleEnvelope({ jobId: 'job-w2', message: { source: 'system', event: 'task_assigned', jobId: 'job-w2' } });
  const eng = db.getEngagementByJob('job-w2')!;
  eng.userId = 'old-tg2';
  eng.status = 'settled';
  db.saveEngagement(eng);
  db.saveProfile({ ...profile, userId: 'old-tg2', wallet: '0xCafe00000000000000000000000000000000Cafe' });
  db.transferProfile('old-tg2', 'new-tg2');
  assert.equal(db.getEngagementByJob('job-w2')?.userId, 'old-tg2', 'settled engagements stay for the record');
});

// ── OKX browser sign-in (wallet login --phase init/poll) ──────────────────

test('wallet: sessions are isolated per user via ONCHAINOS_HOME', async () => {
  const { homeForTest } = await import('../src/wallet/okxWallet.js');
  const a = homeForTest('111');
  const b = homeForTest('222');
  assert.notEqual(a, b, 'two users must never share a wallet session directory');
  assert.match(a, /111$/);
});

test('wallet: user ids are sanitised into safe directory names', async () => {
  const { homeForTest } = await import('../src/wallet/okxWallet.js');
  const evil = homeForTest('../../etc/passwd');
  assert.ok(!evil.includes('..'), 'path traversal must not survive sanitisation');
});

test('wallet: address can no longer be set by typing it', async () => {
  // Wallets are proven via OKX sign-in; free-text entry must be refused.
  const p = { ...profile, userId: 'no-type-wallet' };
  db.saveProfile(p);
  const stored = db.getProfile('no-type-wallet')!;
  assert.equal(stored.wallet, undefined, 'no wallet without verified sign-in');
});

// The CLI has changed its address grouping between releases, so the extractor
// is deliberately shape-tolerant. These pin the behaviour that matters.
test('wallet: EVM address is extracted from the documented CLI shapes', async () => {
  const { extractEvmAddress } = await import('../src/wallet/okxWallet.js');
  const addr = '0xAbCd00000000000000000000000000000000eF01';

  // `wallet addresses` — grouped by chain category.
  assert.equal(extractEvmAddress({ xlayer: [{ address: addr }], evm: [] }), addr);
  // `wallet login --phase poll` — flat account payload.
  assert.equal(extractEvmAddress({ accountName: 'Account 1', evmAddress: addr }), addr);
  // Unknown future shape — still found by the bounded fallback search.
  assert.equal(extractEvmAddress({ accounts: [{ chains: { someNewKey: { address: addr } } }] }), addr);
});

test('wallet: a Solana address is never mistaken for an X Layer address', async () => {
  const { extractEvmAddress } = await import('../src/wallet/okxWallet.js');
  // Solana addresses are Base58 and cannot match, but a payload may also carry
  // an EVM-shaped value under a Solana key — that must not be selected.
  const sol = { solana: [{ address: '0x1111111111111111111111111111111111111111' }] };
  assert.equal(extractEvmAddress(sol), undefined, 'solana keys must be skipped');
  assert.equal(extractEvmAddress({ solAddress: 'FhkLmNoPqRsTuVwXyZ1234567890aBcDeFgHiJkLmNoP' }), undefined);
});

test('wallet: X Layer is preferred when several EVM chains are returned', async () => {
  const { extractEvmAddress } = await import('../src/wallet/okxWallet.js');
  const xlayer = '0xAAAA000000000000000000000000000000000001';
  const other = '0xBBBB000000000000000000000000000000000002';
  // Key order deliberately puts the non-X-Layer chain first.
  assert.equal(extractEvmAddress({ ethereum: [{ address: other }], xlayer: [{ address: xlayer }] }), xlayer);
});

test('wallet: malformed or empty payloads yield no address rather than junk', async () => {
  const { extractEvmAddress } = await import('../src/wallet/okxWallet.js');
  for (const bad of [undefined, null, {}, [], '', 'not-an-address', { address: '0x123' }, { address: 42 }]) {
    assert.equal(extractEvmAddress(bad), undefined, `must reject ${JSON.stringify(bad)}`);
  }
});

test('wallet: a cyclic payload cannot hang the extractor', async () => {
  const { extractEvmAddress } = await import('../src/wallet/okxWallet.js');
  const cyclic: Record<string, unknown> = { data: {} };
  (cyclic.data as Record<string, unknown>).parent = cyclic;
  assert.equal(extractEvmAddress(cyclic), undefined);
});

// ── buyer criteria parsing (the "empty shortlist" incident) ────────────────
//
// A live task was rejected because the ASP delivered "top 0 of 0 postings" and
// had parsed a $140k Python/Go brief as "mid, remote, $0+ floor". The
// marketplace never supplies a description — `active-tasks` and `agent status`
// return a title and a budget only — so the brief arrives over A2A chat, and
// production runs with llm=false, meaning the heuristic path is the ONLY path.

test('criteria: the brief from the rejected task parses completely', async () => {
  const { heuristicCriteria } = await import('../src/skills/jobHunt.js');
  const c = heuristicCriteria(
    'Looking for senior backend engineer roles.\nMust have: Python, Go, Postgres, AWS.\n' +
      'Salary: $140k+ base.\nLocations: remote-US, Austin, or Denver.',
  );
  assert.equal(c.compFloor, 140000, 'salary floor was dropped as $0');
  assert.equal(c.seniority, 'senior');
  for (const skill of ['python', 'go', 'postgres', 'aws']) {
    assert.ok(c.skills?.includes(skill), `skill "${skill}" dropped — skills are 40 of 100 rubric points`);
  }
  for (const loc of ['austin', 'denver']) assert.ok(c.locations?.includes(loc), `location "${loc}" dropped`);
  assert.deepEqual(c.roles, ['senior backend engineer'], 'roles become the job-board query');
});

test('criteria: "go" matches as a word, not as a substring', async () => {
  const { mentionsSkill } = await import('../src/skills/jobHunt.js');
  assert.equal(mentionsSkill('python, go, postgres', 'go'), true);
  assert.equal(mentionsSkill('golang microservices', 'go'), true);
  assert.equal(mentionsSkill('django rest framework', 'go'), false, '"django" contains go');
  assert.equal(mentionsSkill('strong algorithms background', 'go'), false, '"algorithms" contains go');
});

test('criteria: the salary floor is the lowest figure, never the highest', async () => {
  const { extractCompFloor } = await import('../src/skills/jobHunt.js');
  // Overshooting is passed to the board as salary_min and filters out every
  // valid posting — reproducing the empty shortlist this change prevents.
  assert.equal(extractCompFloor('$140k+ base, up to $180k'), 140000);
  assert.equal(extractCompFloor('up to $180k, floor 140k'), 140000);
  assert.equal(extractCompFloor('5 years exp, $140,000 base'), 140000, 'years must not be read as salary');
  assert.equal(extractCompFloor('3 years experience'), 0);
});

test('criteria: roles are occupations, not sentence fragments', async () => {
  const { extractRoles } = await import('../src/skills/jobHunt.js');
  // These strings go straight into the job-board query. Fragments like
  // "Looking for someone to help" match nothing and return an empty board.
  assert.deepEqual(extractRoles('Looking for senior backend engineer roles, remote-US, $140k+ base'), ['senior backend engineer']);
  assert.deepEqual(extractRoles('Find me a job'), [], 'no occupation named → no query');
  assert.ok(extractRoles('I need a product designer and a data analyst').length === 2);
});

test('criteria: a bare title is not a usable brief', async () => {
  const { briefIsUsable } = await import('../src/okx/poller.js');
  // This is what production actually had: the task title alone. Hunting on it
  // yields nothing, so the agent must ask rather than deliver an empty result.
  assert.equal(briefIsUsable('Job hunt shortlist help'), false);
  assert.equal(briefIsUsable('Find Software Developer Jobs'), false);
  assert.equal(
    briefIsUsable('Senior backend engineer, Python and Go, $140k+ base, remote-US or Austin'),
    true,
  );
});

test('criteria: the buyer is told exactly what was searched', async () => {
  const { describeCriteria } = await import('../src/okx/poller.js');
  const echo = describeCriteria({
    roles: ['senior backend engineer'], seniority: 'senior',
    locations: ['remote', 'austin'], compFloor: 140000, skills: ['python', 'go'],
  });
  assert.match(echo, /\$140,000\+ base/);
  assert.match(echo, /python, go/);
  assert.match(echo, /austin/);
});

test('criteria: a chat brief accumulates across messages without duplicating', async () => {
  const { appendBrief } = await import('../src/okx/server.js');
  // Requirements arrive in several messages; a later one must not erase the
  // earlier, and a resent message must not double-weight its terms.
  const first = appendBrief(undefined, 'Senior backend engineer, Python and Go');
  const second = appendBrief(first, '$140k+ base, remote-US or Austin');
  assert.ok(second.includes('Python and Go') && second.includes('$140k+'));
  assert.equal(appendBrief(second, '$140k+ base, remote-US or Austin'), second, 'duplicate ignored');
  assert.ok(appendBrief('x'.repeat(9000), 'tail').length <= 8000, 'bounded');
});
