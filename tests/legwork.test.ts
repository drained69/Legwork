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
// Remotive needs no key, so it stays live unless switched off explicitly —
// and these tests assert the keyless MOCK fixtures. Production deliberately
// has no mock fallback: inventing postings and presenting them as live
// openings would be worse than returning nothing.
process.env.REMOTIVE_ENABLED = 'false';
process.env.ADZUNA_APP_ID = '';
process.env.ADZUNA_APP_KEY = '';
process.env.USAJOBS_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
// Both providers, or dotenv's real key leaks in and the suite makes live API
// calls — slow, quota-burning, and dependent on someone else's uptime.
process.env.ANTHROPIC_AUTH_TOKEN = '';
process.env.GEMINI_API_KEY = '';
process.env.GOOGLE_API_KEY = '';
process.env.GMAIL_CLIENT_ID = '';
process.env.GMAIL_CLIENT_SECRET = '';
process.env.GMAIL_REFRESH_TOKEN = '';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('../src/db.js');
const { scanForUser } = await import('../src/skills/jobScraper.js');
const { scorePosting } = await import('../src/skills/matchScorer.js');
const { tailorApplication } = await import('../src/skills/applicationTailor.js');
const { submitApplication, resolveSubmissionTarget } = await import('../src/skills/applyExecutor.js');
const { runScanCycle } = await import('../src/pipeline.js');

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
  const first = await scanForUser(p);
  assert.ok(first.newPostings.length >= 5, 'expected mock postings on first scan');
  const second = await scanForUser(p);
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
    id: db.uid(), userId: profile.userId, postingId: posting.id,
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
    id: db.uid(), userId: profile.userId, postingId: posting.id,
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
    id: db.uid(), userId: profile.userId, postingId: posting.id,
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

test('db: one application per (user, posting) — duplicate insert rejected', async () => {
  const posting = makePosting({ company: 'DupeCo' });
  const base = {
    userId: 'dupe-user', postingId: posting.id,
    status: 'pending_approval' as const, score: 70,
    breakdown: await scorePosting(profile, posting), createdAt: db.now(),
  };
  assert.equal(db.createApplication({ ...base, id: db.uid() }), true);
  assert.equal(db.createApplication({ ...base, id: db.uid() }), false);
});

// ── pipeline ───────────────────────────────────────────────────────────────

test('pipeline: scan cycle produces cards, then dedupes on the next run', async () => {
  const userId = 'cycle-user';
  db.saveProfile({ ...profile, userId, threshold: 0 });
  const summary = await runScanCycle(db.getProfile(userId)!);
  assert.ok(summary.cards.length >= 1, 'expected at least one match card');

  // second cycle: nothing new (idempotency at the pipeline level)
  const summary2 = await runScanCycle(db.getProfile(userId)!);
  assert.equal(summary2.cards.length, 0);

  // approve + submit the top card
  const top = summary.cards[0];
  top.application.status = 'approved';
  top.application.approvalAt = db.now();
  db.updateApplication(top.application);
  const res = await submitApplication(top.application, db.getProfile(userId)!, top.posting);
  assert.equal(res.ok, true);
});

test('pipeline: daily cap limits match cards', async () => {
  const userId = 'cap-user';
  db.saveProfile({ ...profile, userId, threshold: 0, dailyCap: 2 }); // everything matches, cap 2
  const summary = await runScanCycle(db.getProfile(userId)!);
  assert.equal(summary.cards.length, 2);
  assert.equal(summary.cappedOut, true);
});

// ── job-hunt: the core product ─────────────────────────────────────────────

test('hunt: ad-hoc criteria produce a ranked shortlist', async () => {
  const { runAdhocHunt, criteriaToProfile, formatCriteriaSummary } = await import('../src/skills/jobHunt.js');
  const criteria = {
    roles: ['backend engineer'],
    seniority: 'senior',
    locations: ['remote'],
    compFloor: 0,
    factors: ['equity', 'async-first'],
  };

  assert.match(formatCriteriaSummary(criteriaToProfile(criteria, 'hunt-user')), /Priority factors: equity, async-first/);

  const result = await runAdhocHunt(criteria);
  // 4, not 5: the shortlist is now narrowed to the best class of match that
  // actually exists, so a "Junior Web Developer" no longer appears in a
  // SENIOR BACKEND ENGINEER search just because it is also an engineering job.
  assert.ok(result.matches.length >= 4, 'expected shortlist from mock sources');
  // The top match must be the requested OCCUPATION (an engineer), though not
  // necessarily the exact specialisation: within the relevant class the rubric
  // still ranks, so a "Senior TypeScript Engineer" legitimately beats a
  // non-senior "Backend Engineer" on a SENIOR backend search.
  assert.match(result.matches[0].posting.title, /engineer/i, 'top match should be the requested occupation');
  assert.ok(
    !result.matches.some((m) => /Junior Web Developer/i.test(m.posting.title)),
    'an unrelated junior web role should be filtered out of a senior backend search',
  );
  // Ranked: scores must be non-increasing.
  for (let i = 1; i < result.matches.length; i++) {
    assert.ok(result.matches[i - 1].breakdown.total >= result.matches[i].breakdown.total, 'shortlist must be ranked');
  }
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

// ── wallet identity: one wallet = one profile ──────────────────────────────

test('wallet: getProfileByWallet finds the owner case-insensitively', () => {
  db.saveProfile({ ...profile, userId: 'w-owner', wallet: '0xAbCd00000000000000000000000000000000EF01' });
  const found = db.getProfileByWallet('0xabcd00000000000000000000000000000000ef01');
  assert.equal(found?.userId, 'w-owner');
  assert.equal(db.getProfileByWallet('0x9999000000000000000000000000000000009999'), undefined);
});

test('wallet: transferProfile moves profile and history to the new account', async () => {
  const wallet = '0xBeeF00000000000000000000000000000000BeeF';
  db.saveProfile({ ...profile, userId: 'old-tg', wallet, targetRoles: ['data engineer'] });
  db.markSeen('old-tg', 'posting-w1');

  db.transferProfile('old-tg', 'new-tg');

  assert.equal(db.getProfile('old-tg'), undefined, 'old account no longer holds the profile');
  const moved = db.getProfile('new-tg');
  assert.equal(moved?.wallet, wallet);
  assert.deepEqual(moved?.targetRoles, ['data engineer']);
  assert.equal(db.markSeen('new-tg', 'posting-w1'), false, 'seen history follows — no duplicate cards');
  // Invariant: exactly one profile owns the wallet.
  assert.equal(db.getProfileByWallet(wallet)?.userId, 'new-tg');
});

// ── criteria parsing (the "empty shortlist" incident) ──────────────────────
//
// A hunt was rejected because the agent delivered "top 0 of 0 postings" and
// had parsed a $140k Python/Go brief as "mid, remote, $0+ floor". Production
// runs with llm=false, meaning the heuristic path is the ONLY path.

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
