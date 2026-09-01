/**
 * Job-source parsing. Remotive is keyless, so it is the floor of live
 * coverage — it keeps working when every credential expires.
 */
process.env.DATABASE_PATH = ':memory:';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseSalaryRange } = await import('../src/skills/jobScraper.js');

test('salary: free-text pay strings parse into a usable range', () => {
  assert.deepEqual(parseSalaryRange('$100,000 - $120,000'), { min: 100000, max: 120000 });
  assert.deepEqual(parseSalaryRange('80k-100k USD'), { min: 80000, max: 100000 });
  assert.deepEqual(parseSalaryRange('$150,000'), { min: 150000, max: undefined });
});

test('salary: unparseable pay yields nothing rather than a wrong number', () => {
  // The comp axis scores an unlisted salary as neutral, which is honest. A
  // mis-parsed figure would silently distort every ranking it touched.
  assert.deepEqual(parseSalaryRange(''), {});
  assert.deepEqual(parseSalaryRange(undefined), {});
  assert.deepEqual(parseSalaryRange('Competitive'), {});
  assert.deepEqual(parseSalaryRange('$45/hour'), {}, 'hourly rates are not annual salaries');
  assert.deepEqual(parseSalaryRange('5 years experience'), {}, 'stray small numbers are ignored');
});

test('scoring: useLlm=false makes no network call at all', async () => {
  // Pass 1 of the hunt ranks the WHOLE board this way. If it touched the
  // network it would defeat the entire point of the two-pass split, which
  // exists to fit a 15-requests/minute quota.
  process.env.GEMINI_API_KEY = 'would-be-used-if-called';
  process.env.GEMINI_BASE_URL = 'http://127.0.0.1:1'; // nothing listening
  const { scorePosting } = await import('../src/skills/matchScorer.js');
  const { criteriaToProfile } = await import('../src/skills/jobHunt.js');

  const profile = criteriaToProfile({ roles: ['backend engineer'], skills: ['typescript'] }, 'no-net');
  const posting = {
    id: 'p', source: 'test', externalId: 'p', title: 'Senior Backend Engineer',
    company: 'Acme', location: 'Remote', remote: true,
    description: 'TypeScript and Postgres.', url: 'https://example.com',
    atsHint: 'unknown', fetchedAt: new Date().toISOString(),
  };
  const t0 = Date.now();
  const b = await scorePosting(profile, posting as never, { useLlm: false });
  const elapsed = Date.now() - t0;

  assert.ok(b.total >= 0 && b.total <= 100, 'still produces a full score');
  assert.ok(b.skills.reason.length > 0, 'still explains the skills axis');
  // A real connection attempt to a dead port would burn far more than this.
  assert.ok(elapsed < 250, `should be instant, took ${elapsed}ms`);
});
