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

// ── evidence bundle ────────────────────────────────────────────────────────

test('evidence bundle lists every application with approval + receipt fields', async () => {
  const engagement = db.getEngagementByJob('job-B')!;
  const bundle = buildEvidenceBundle(engagement);
  assert.match(bundle, /approvedAt=20/); // ISO timestamp present
  assert.match(bundle, /receipt=/);
});
