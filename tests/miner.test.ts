/**
 * Telegraph miner surface tests — the routes the protocol's nodes call.
 *
 * Boots the real HTTP server on an ephemeral port with all external services
 * disabled (mock job source, heuristic tailoring), then exercises the miner
 * contract: open access, signal_mapping-shaped responses, verbatim YAML
 * serving, and honest 4xx errors for malformed input.
 */
process.env.DATABASE_PATH = ':memory:';
process.env.ANTHROPIC_API_KEY = '';
// Both providers, or dotenv's real key leaks in and the suite makes live API
// calls — slow, quota-burning, and dependent on someone else's uptime.
process.env.ANTHROPIC_AUTH_TOKEN = '';
process.env.GEMINI_API_KEY = '';
process.env.GOOGLE_API_KEY = '';
// Remotive needs no key, so it stays live unless switched off — which made
// this suite depend on a third party's uptime and on what happened to be
// posted that minute. Off here, the keyless mock fixtures make every
// assertion deterministic.
process.env.REMOTIVE_ENABLED = 'false';
process.env.ADZUNA_APP_ID = '';
process.env.ADZUNA_APP_KEY = '';
process.env.USAJOBS_API_KEY = '';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const { startServer } = await import('../src/server.js');
const { PRICED_SERVICES } = await import('../src/payments/services.js');

const server = startServer(0);
await new Promise<void>((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

test.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

test('pricing: services cost their published price exactly', () => {
  assert.ok(PRICED_SERVICES.length > 0);
  const expected: Record<string, string> = {
    'job-hunt': '0.01',
    'score-posting': '0.01',
    'tailor-application': '0.01',
    // Redflag buys up to four live miner answers per report, so it is priced
    // above the single-call services — deliberately, not drift.
    'redflag-vetting': '0.05',
  };
  for (const service of PRICED_SERVICES) {
    assert.equal(service.priceUsd, expected[service.id], `${service.id} USD price drifted`);
    assert.equal(service.priceAtomic, String(Math.round(Number(expected[service.id]) * 1_000_000)), `${service.id} atomic USDC price drifted`);
  }
  assert.equal(PRICED_SERVICES.length, Object.keys(expected).length, 'new services must declare their price here');
});

test('miner: /miner.yaml serves the registered file verbatim', async () => {
  const res = await fetch(`${base}/miner.yaml`);
  assert.equal(res.status, 200);
  const body = await res.text();
  // The served bytes are what the on-chain SHA-256 commits to — they must be
  // byte-identical to the repo file, not a re-serialization.
  const { readFileSync } = await import('node:fs');
  const onDisk = readFileSync(new URL('../miner.yaml', import.meta.url), 'utf8');
  assert.equal(body, onDisk);
  const hash = createHash('sha256').update(body).digest('hex');
  assert.match(hash, /^[0-9a-f]{64}$/);
  // Required identity fields present.
  assert.match(body, /^version: "1"$/m);
  assert.match(body, /^kind: miner$/m);
  assert.match(body, /^slug: legwork-job-hunter$/m);
  assert.match(body, /^  min_price_usdc: 0\.01$/m);
});

test('miner: free-text query returns a signal-shaped ranked shortlist', async () => {
  const res = await fetch(`${base}/miner/job-hunt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'senior backend engineer, TypeScript, remote, $120k+' }),
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as {
    label: string; confidence: number; reason: string; found: number;
    matches: Array<{ title: string; score: number; breakdown: { skills: { reason: string } } }>;
  };
  assert.ok(data.label.length > 0, 'label_field must resolve');
  assert.ok(data.confidence > 0 && data.confidence <= 1, 'confidence_field must be 0-1');
  assert.ok(data.reason.length > 10, 'reason_field must resolve');
  assert.ok(data.matches.length >= 1, 'mock source should produce matches');
  for (let i = 1; i < data.matches.length; i++) {
    assert.ok(data.matches[i - 1].score >= data.matches[i].score, 'shortlist must be ranked');
  }
});

test('miner: structured criteria work without a query string', async () => {
  const res = await fetch(`${base}/miner/job-hunt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roles: ['backend engineer'], seniority: 'senior', locations: ['remote'] }),
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { matches: unknown[] };
  assert.ok(Array.isArray(data.matches));
});

test('miner: structured tailor with candidate + posting returns full documents', async () => {
  const good = await fetch(`${base}/miner/tailor`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      candidate: { name: 'Ada Lovelace', resumeText: 'Engineer, 10 years.', skills: ['typescript'] },
      posting: { title: 'Senior Engineer', company: 'TestCo', description: 'TypeScript role.' },
    }),
  });
  assert.equal(good.status, 200);
  const data = (await good.json()) as { label: string; confidence: number; coverLetter: string; match_count: number };
  assert.match(data.label, /Tailored application for Senior Engineer @ TestCo/);
  assert.ok(data.confidence > 0 && data.confidence <= 1);
  assert.ok(data.coverLetter.length > 0);
  assert.equal(data.match_count, 0);
});

test('miner: prompt-only tailor (TEXT_GENERATION probe shape) never 400s', async () => {
  // Validators send free-text writing tasks, not structured objects. A 400
  // there scores 0 — the generation path must always answer.
  const res = await fetch(`${base}/miner/tailor`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'Write a cover letter for a senior backend engineer position at Acme Corp' }),
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as {
    label: string; confidence: number; reason: string; match_count: number;
    generatedText: string; coverLetter?: string;
  };
  assert.ok(data.label.length > 0, 'label_field must resolve');
  assert.ok(data.confidence > 0 && data.confidence <= 1);
  assert.ok(data.reason.length > 10, 'reason_field must resolve');
  assert.equal(data.match_count, 0, 'on_chain match_count must always resolve');
  assert.ok(data.generatedText.length > 50, 'generation path must produce a real draft');
  assert.ok(data.coverLetter && data.coverLetter.length > 50, 'cover-letter prompts produce a coverLetter');
});

test('miner: template tailor weaves facts stated in the prompt (keyless mode)', async () => {
  const res = await fetch(`${base}/miner/tailor`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'Write a cover letter for a backend engineer position at Acme Corp. I have 8 years of TypeScript and Postgres experience.' }),
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { coverLetter: string };
  // Stated facts must appear in the draft instead of bare placeholders.
  assert.match(data.coverLetter, /8 years/, 'stated years are woven in');
  assert.match(data.coverLetter, /TypeScript/i, 'stated skills are woven in');
  assert.match(data.coverLetter, /Dear Acme Corp hiring team/);
});

test('miner: /health surfaces LLM key validity and live sources', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const data = (await res.json()) as { ok: boolean; llm: { configured: boolean; lastStatus: string | null }; sources: Record<string, boolean> };
  assert.equal(data.ok, true);
  assert.equal(typeof data.llm.configured, 'boolean');
  assert.ok(data.llm.lastStatus === null || ['ok', 'error'].includes(data.llm.lastStatus));
  assert.ok('adzuna' in data.sources && 'usajobs' in data.sources);
});

test('miner: a totally empty tailor body still answers (never-fail surface)', async () => {
  // A 400 here would score 0 — the surface must degrade to a real answer.
  const res = await fetch(`${base}/miner/tailor`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { label: string; confidence: number; match_count: number };
  assert.ok(data.label.length > 0);
  assert.ok(data.confidence > 0 && data.confidence <= 1);
  assert.equal(data.match_count, 0);
});

test('miner: job-hunt accepts alias task fields the builder might send', async () => {
  for (const field of ['question', 'prompt', 'text']) {
    const res = await fetch(`${base}/miner/job-hunt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [field]: 'backend engineer jobs, remote' }),
    });
    assert.equal(res.status, 200, `${field} alias must be accepted`);
    const data = (await res.json()) as { matches: unknown[] };
    assert.ok(Array.isArray(data.matches));
  }
});

test('miner: empty job-hunt body still scans (never-fail for probes)', async () => {
  const res = await fetch(`${base}/miner/job-hunt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { label: string; matches: unknown[] };
  assert.ok(data.label.length > 0);
});

test('miner: tailor accepts JSON-encoded strings (on_chain request mapping shape)', async () => {
  // on_chain.request maps OnChainData string slots directly into body fields,
  // so candidate/posting arrive as JSON strings rather than objects.
  const res = await fetch(`${base}/miner/tailor`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      candidate: JSON.stringify({ name: 'Ada Lovelace', resumeText: 'Engineer, 10 years.', skills: ['typescript'] }),
      posting: JSON.stringify({ title: 'Senior Engineer', company: 'TestCo', description: 'TypeScript role.' }),
    }),
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { label: string; match_count: number };
  assert.match(data.label, /Tailored application for Senior Engineer @ TestCo/);
  assert.equal(data.match_count, 0, 'tailor must satisfy the on_chain match_count field');
});

test('miner: invalid JSON is salvaged into a task, never a 400', async () => {
  const res = await fetch(`${base}/miner/job-hunt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json{',
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { label: string; match_count: number };
  assert.ok(data.label.length > 0, 'salvaged body still answers');
});

test('miner: unknown miner path routes on body shape, never 404s', async () => {
  // A 404 scores exactly 0 — an unrecognized path is answered by the handler
  // its body resembles.
  const res = await fetch(`${base}/miner/nope`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'backend engineer jobs, remote' }),
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { matches: unknown[] };
  assert.ok(Array.isArray(data.matches));
});

test('miner: routes stay up when a handler fails (process isolation)', async () => {
  await fetch(`${base}/miner/job-hunt`, { method: 'POST', body: 'garbage' }).catch(() => {});
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
});

test('scope gate: a job request without a named occupation is still answered', async () => {
  // This gate tested for "names an occupation or a skill", which declined 15 of
  // 18 realistic phrasings — "I need a new job" came back as "not a job-search
  // query". Those requests were unmistakably for this miner; answering nothing
  // is a worse failure than answering broadly.
  for (const q of [
    'I need a new job',
    'help me find work',
    'who is hiring near me',
    'remote work opportunities',
    'jobs for recent graduates',
    'part-time evening work',
  ]) {
    const res = await fetch(`${base}/miner/job-hunt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: q }),
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { confidence: number; match_count: number; reason: string };
    // The property is that job INTENT was recognised, not that a live board
    // happened to have stock — asserting on match counts makes this flaky.
    assert.ok(!/^Not a job-search query/.test(data.label), `"${q}" must not be refused as off-topic: ${data.label}`);
    // A broad search is a real answer but a weaker one, and must say so
    // rather than presenting itself as targeted.
    assert.ok(data.confidence <= 0.6, `"${q}" should report broad-search confidence, got ${data.confidence}`);
    assert.match(data.reason, /broad search/i);
  }
});

test('scope gate: genuinely off-topic questions are still declined', async () => {
  for (const q of ['what is the capital of France', 'weather in Tokyo', 'price of bitcoin', 'who won the world cup']) {
    const res = await fetch(`${base}/miner/job-hunt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: q }),
    });
    const data = (await res.json()) as { confidence: number; match_count: number };
    assert.ok(data.confidence <= 0.2, `"${q}" must be declined, got ${data.confidence}`);
    assert.equal(data.match_count, 0);
  }
});

test('shortlist is ranked on ONE scale, best first', async () => {
  // The LLM pass rewrites REASONS only. When it rewrote scores too, a
  // keyword-scored posting that never earned the LLM pass could outrank an
  // LLM-scored one — a DevOps role came first on a backend search.
  const res = await fetch(`${base}/miner/job-hunt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'senior backend engineer, TypeScript, remote' }),
  });
  const { matches } = (await res.json()) as { matches: Array<{ score: number }> };
  assert.ok(matches.length > 1, 'need several matches to check ordering');
  for (let i = 1; i < matches.length; i++) {
    assert.ok(matches[i - 1].score >= matches[i].score, `rank ${i} (${matches[i].score}) outranks ${i - 1} (${matches[i - 1].score})`);
  }
});

test('a writing task sent to the search endpoint is written, not searched', async () => {
  const res = await fetch(`${base}/miner/job-hunt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'write a cover letter for a backend engineer at Acme Corp' }),
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { generatedText?: string; coverLetter?: string };
  assert.ok((data.generatedText ?? data.coverLetter ?? '').length > 100, 'should return a written document');
});

test('every HTTP method on a miner path is scoreable, never a 404', async () => {
  // A non-2xx is a guaranteed zero: the engine stores an empty answer and the
  // scorer never reads the body. A GET or HEAD probe used to fall through to
  // the server's 404 — a scored zero for a request we could have answered.
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const res = await fetch(`${base}/miner/job-hunt`, { method });
    assert.equal(res.status, 200, `${method} must not 404`);
    const data = (await res.json()) as { label: string; confidence: number; reason: string };
    assert.ok(typeof data.label === 'string' && data.label.length > 0, `${method} must carry a label`);
    assert.ok(data.confidence > 0 && data.confidence <= 1, `${method} must carry a confidence`);
    assert.ok(typeof data.reason === 'string' && data.reason.length > 10, `${method} must carry a reason`);
  }
  const head = await fetch(`${base}/miner/job-hunt`, { method: 'HEAD' });
  assert.equal(head.status, 200, 'HEAD must not 404');
});
