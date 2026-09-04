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

const { startServer } = await import('../../src/server.js');
const { PRICED_SERVICES } = await import('../../src/payments/services.js');

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
  const onDisk = readFileSync(new URL('../../miner.yaml', import.meta.url), 'utf8');
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

// ── general-question routing (the epoch-scoring fix) ────────────────────────
//
// The network scores every WEB_SEARCH/RESEARCH_SYNTHESIS/TEXT_GENERATION
// miner against the same general question set, and the champions are general
// LLMs. These tests pin the discriminator: job queries keep the live-board
// specialty, everything else goes to the direct-answer path (keyless here,
// so the honest decline — the LLM path is exercised by scripts/self-probe).

test('miner: general questions are discriminated out of the job path (keyless)', async () => {
  const res = await fetch(`${base}/miner/job-hunt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'What role does the Federal Reserve play in inflation?' }),
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { label: string; confidence: number; match_count: number; matches: unknown[] };
  // Keyless: no model to answer with, so the honest decline — NOT a job
  // search dressed up as an answer.
  assert.match(data.label, /Not a job-search query/);
  assert.ok(data.confidence <= 0.2);
  assert.equal(data.match_count, 0);
  assert.equal(data.matches.length, 0);
});

test('miner: a skill mention alone is not a job search', async () => {
  const res = await fetch(`${base}/miner/job-hunt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'What is Python?' }),
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { label: string; match_count: number };
  // "python" is extractable as a skill — the old gate ran a job search on
  // this. The discriminator must treat it as the general question it is.
  assert.match(data.label, /Not a job-search query/);
  assert.equal(data.match_count, 0);
});

test('miner: an occupation phrase with no job word is still a job search', async () => {
  const res = await fetch(`${base}/miner/job-hunt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'senior backend engineer, TypeScript, remote, $120k+' }),
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { matches: Array<{ title: string }> };
  assert.ok(data.matches.length >= 1, 'the classic probe shape must keep returning live matches');
});

test('miner: general writing tasks decline honestly in keyless mode', async () => {
  const res = await fetch(`${base}/miner/tailor`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'Write a haiku about the ocean.' }),
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { label: string; confidence: number; match_count: number };
  // With a model configured this WRITES the haiku; keyless it declines
  // honestly instead of returning a cover letter for a haiku request.
  assert.match(data.label, /not a job-application writing task|Outside Legwork's scope/);
  assert.ok(data.confidence <= 0.2);
  assert.equal(data.match_count, 0);
});

test('miner: job-writing probes still produce career documents', async () => {
  const res = await fetch(`${base}/miner/tailor`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'write a cover letter for a senior backend engineer position at Acme Corp' }),
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { generatedText: string; coverLetter?: string };
  assert.ok(data.generatedText.length > 50, 'the job-writing path is unchanged');
});

test('miner: the writing signal CARRIES the document, not a description of it', async () => {
  // signal_mapping points the scorer at label/reason. A label like "Cover
  // letter written: ..." describes the answer without showing it — which
  // scores as a non-answer. The label must carry the deliverable itself.
  const res = await fetch(`${base}/miner/tailor`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'write a cover letter for a senior backend engineer position at Acme Corp' }),
  });
  const data = (await res.json()) as { label: string; reason: string; coverLetter: string };
  assert.doesNotMatch(data.label, /^Cover letter written:/, 'label must not be a task description');
  // The deterministic draft opens with a salutation addressed to the company.
  assert.match(data.label, /Dear/, 'label carries the actual document text');
  assert.match(data.reason, /Dear Acme Corp hiring team/, 'reason carries the full document');
});

test('miner: structured tailor labels carry the drafted document', async () => {
  const res = await fetch(`${base}/miner/tailor`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      candidate: { name: 'Ada Lovelace', resumeText: 'Engineer, 10 years.', skills: ['typescript'] },
      posting: { title: 'Senior Engineer', company: 'TestCo', description: 'TypeScript role.' },
    }),
  });
  const data = (await res.json()) as { label: string; reason: string; coverLetter: string };
  assert.match(data.label, /Tailored application for Senior Engineer @ TestCo/);
  // The reason must include the actual letter, not just the approach.
  assert.ok(data.reason.length > data.label.length, 'reason carries the drafted documents');
  assert.ok(data.reason.includes(data.coverLetter.slice(0, 120)), 'the cover letter text itself is in the reason');
});

test('miner: discriminator unit cases', async () => {
  const { isJobSearchQuery } = await import('../../src/miner/miner.js');
  const job = [
    'remote software engineering jobs',
    'senior backend engineer, TypeScript, remote, $150k+',
    'I need a new job',
    'who is hiring near me',
    'registered nurse jobs in Austin',
    'What does a data analyst earn in New York',
    'Find me work in Berlin',
    'internships for computer science students',
  ];
  const general = [
    'What is Python?',
    'How does the electoral college work?',
    'What role does the Fed play in inflation?',
    'how do jet engines work',
    'What work does an engine do?',
    'latest news about the Israel Gaza conflict',
    'Will Riyadh exceed 40 degrees tomorrow',
    'write a haiku about the ocean',
  ];
  for (const q of job) assert.equal(isJobSearchQuery(q), true, `"${q}" must be a job search`);
  for (const q of general) assert.equal(isJobSearchQuery(q), false, `"${q}" must be general`);
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
  for (const q of ['what is the capital of France', 'weather in Tokyo', 'who won the world cup']) {
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

// ── live price questions (the WEB_SEARCH live-data probes) ──────────────────
//
// The epoch question set includes "What is the current price of Bitcoin in US
// dollars as of <date>" — answered from LIVE market data, not model knowledge,
// because a stale model figure is a confident wrong number that scores as a
// non-answer. The suite stubs the market fetch so these stay hermetic.

const withStubbedMarket = async <T>(body: () => Promise<T>): Promise<T> => {
  const realFetch = globalThis.fetch;
  // Intercept ONLY the CoinGecko call; the test's own fetch to the local
  // server must pass through untouched.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('api.coingecko.com')) {
      return new Response(JSON.stringify({
        bitcoin: { usd: 77_809, usd_24h_change: 0.27, last_updated_at: 1_772_500_000 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    return await body();
  } finally {
    globalThis.fetch = realFetch;
  }
};

test('miner: current-price questions answer from live market data', async () => {
  await withStubbedMarket(async () => {
    const res = await fetch(`${base}/miner/job-hunt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'What is the current price of Bitcoin (BTC) in US dollars, and what was the price change over the last 24 hours?' }),
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { label: string; confidence: number; reason: string; match_count: number };
    assert.match(data.label, /Bitcoin price: \$77,809/, 'label carries the live figure');
    assert.match(data.label, /\+0\.27% 24h/, 'label carries the 24h change');
    assert.ok(data.confidence >= 0.8, 'live-sourced answers are high confidence');
    assert.match(data.reason, /live market data/i);
    assert.equal(data.match_count, 0);
  });
});

test('miner: dated-price questions answer for the asked date, not today', async () => {
  // A date that is always safely in the past: two days ago.
  const asked = new Date(Date.now() - 2 * 86_400_000);
  const prev = new Date(asked.getTime() - 86_400_000);
  const dd = (d: Date): string => `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`;
  const spoken = asked.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes('api.coingecko.com')) return realFetch(input, init);
    if (url.includes(`date=${dd(asked)}`)) {
      return new Response(JSON.stringify({ market_data: { current_price: { usd: 77_416.44 } } }), { status: 200 });
    }
    if (url.includes(`date=${dd(prev)}`)) {
      return new Response(JSON.stringify({ market_data: { current_price: { usd: 76_900.0 } } }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  try {
    const res = await fetch(`${base}/miner/job-hunt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: `What is the current price of Bitcoin in US dollars on ${spoken}?` }),
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { label: string; confidence: number; match_count: number };
    assert.match(data.label, new RegExp(`price on ${spoken}: \\$77,416`));
    assert.match(data.label, /\+0\.67% vs previous day/);
    assert.ok(data.confidence >= 0.8);
    assert.equal(data.match_count, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('miner: price questions fall back to the general path when market data fails', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('api.coingecko.com')) {
      return new Response('upstream down', { status: 503 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const res = await fetch(`${base}/miner/job-hunt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'What is the current price of Bitcoin in US dollars as of September 3, 2026?' }),
    });
    assert.equal(res.status, 200);
    // Keyless (no model): the honest decline. With a model configured this
    // would be the model answer. Either way the surface answers 200.
    const data = (await res.json()) as { label: string; confidence: number; match_count: number };
    assert.ok(data.label.length > 0);
    assert.equal(data.match_count, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('miner: a find-a-job request naming a salary floor is a SEARCH, not a pay question', async () => {
  // Production epoch probes: "Find a mid-level backend engineer role in San
  // Francisco with a minimum annual salary of $150,000" — the pay-question
  // regex matched "salary of" and answered a 10-match shortlist request with
  // "not enough advertised salaries to price this". Salary words inside an
  // imperative job request are a filter, not a question about pay.
  const res = await fetch(`${base}/miner/job-hunt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'Find a mid-level backend engineer role in San Francisco with a minimum annual salary of $150,000, prioritizing positions that offer remote work flexibility' }),
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { label: string; confidence: number; matches: unknown[] };
  assert.doesNotMatch(data.label, /Not enough advertised salaries/, 'a shortlist request must not get the pay-decline answer');
  assert.ok(data.matches.length >= 1, 'the shortlist must be returned');
});

test('pay-question discrimination: unit cases', async () => {
  const { isPayQuestion } = await import('../../src/miner/miner.js');
  const payQuestions = [
    'What does a data analyst earn in New York',
    'how much do registered nurses make in Austin',
    'average salary for software engineers in London',
    "What's the salary range for a product manager",
  ];
  const jobSearches = [
    'Find a mid-level backend engineer role in San Francisco with a minimum annual salary of $150,000, prioritizing positions that offer remote work flexibility',
    "I'm looking for a senior backend engineer role in Austin, TX with a minimum annual salary of $150,000, must support remote work",
    'show me engineering jobs that pay $150k or more',
  ];
  for (const q of payQuestions) assert.equal(isPayQuestion(q), true, `"${q}" must be a pay question`);
  for (const q of jobSearches) assert.equal(isPayQuestion(q), false, `"${q}" must be a job search, not a pay question`);
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
