/**
 * Grounded-answer and key-pool tests.
 *
 * The Gemini path is exercised with a FAKE key and a stubbed fetch: the
 * generativelanguage endpoint is intercepted (everything else passes
 * through), so the full pipeline — general question → llmGrounded →
 * googleSearch tool → sources surfaced in the signal — runs hermetically.
 *
 * Key-pool behavior: a 429 on the first key must rotate to the second WITHIN
 * the same request, not stand the model down.
 */
process.env.DATABASE_PATH = ':memory:';
// A fake pool of two keys — real .env keys must never leak into this suite.
process.env.GEMINI_API_KEY = 'test-key-AAAA1111';
process.env.GEMINI_API_KEY_2 = 'test-key-BBBB2222';
process.env.ANTHROPIC_API_KEY = '';
process.env.ANTHROPIC_AUTH_TOKEN = '';
process.env.ANTHROPIC_BASE_URL = '';
process.env.GOOGLE_API_KEY = '';
process.env.ADZUNA_APP_ID = '';
process.env.ADZUNA_APP_KEY = '';
process.env.USAJOBS_API_KEY = '';
process.env.REMOTIVE_ENABLED = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { startServer } = await import('../src/server.js');
const { resetKeyPoolForTests } = await import('../src/llm.js');

const server = startServer(0);
await new Promise<void>((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
test.after(() => new Promise<void>((resolve) => server.close(() => resolve)));

// Per-key pool state is deliberately long-lived in production; tests need a
// clean pool before any test that counts key attempts.
const freshPool = async (): Promise<void> => {
  resetKeyPoolForTests();
  await new Promise((resolve) => setTimeout(resolve, 5));
};

interface StubCall {
  url: string;
  apiKey: string;
  tools?: unknown;
}

/**
 * Install a fetch stub that intercepts ONLY the Gemini endpoint.
 * `respond` decides the response per call; calls are recorded.
 */
function stubGemini(respond: (call: StubCall, n: number) => Response): void {
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes('generativelanguage.googleapis.com')) return realFetch(input, init);
    n += 1;
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body ?? '{}')) as { tools?: unknown };
    const call: StubCall = { url, apiKey: String(headers.get('x-goog-api-key') ?? ''), tools: body.tools };
    return respond(call, n);
  }) as typeof fetch;
}

const GROUNDED_REPLY = (answer: string, sources: Array<{ title: string; uri: string }>): string =>
  JSON.stringify({
    candidates: [{
      content: { parts: [{ text: `{"answer": "${answer}"}` }] },
      finishReason: 'STOP',
      groundingMetadata: {
        webSearchQueries: ['federal reserve inflation'],
        groundingChunks: sources.map((s) => ({ web: { title: s.title, uri: s.uri } })),
      },
    }],
  });

const PLAIN_REPLY = (answer: string): string =>
  JSON.stringify({ candidates: [{ content: { parts: [{ text: `{"answer": "${answer}"}` }] }, finishReason: 'STOP' }] });

const GENERAL_Q = 'What role does the Federal Reserve play in inflation?';

test('grounded: general answers carry live sources and honest confidence', async () => {
  stubGemini(() =>
    new Response(GROUNDED_REPLY('The Fed steers inflation via the federal funds rate.', [
      { title: 'Federal Reserve — monetary policy', uri: 'https://www.federalreserve.gov/monetarypolicy' },
      { title: 'Reuters — Fed coverage', uri: 'https://reuters.com/markets/fed' },
    ]), { status: 200, headers: { 'content-type': 'application/json' } }));
  const res = await fetch(`${base}/miner/job-hunt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: GENERAL_Q }),
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { label: string; confidence: number; reason: string; match_count: number };
  assert.match(data.label, /federal funds rate/);
  assert.equal(data.confidence, 0.8, 'a live-sourced answer earns the higher confidence');
  assert.match(data.reason, /GROUNDED IN LIVE WEB SEARCH/);
  assert.match(data.reason, /federalreserve\.gov/);
  assert.match(data.reason, /reuters\.com/);
  assert.equal(data.match_count, 0);
});

test('grounded: the googleSearch tool is requested on the wire', async () => {
  let seenTools: unknown;
  stubGemini((call) => {
    seenTools = call.tools;
    return new Response(GROUNDED_REPLY('Answer.', [{ title: 'src', uri: 'https://example.com/x' }]), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  await fetch(`${base}/miner/job-hunt`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: GENERAL_Q }),
  });
  assert.deepEqual(seenTools, [{ googleSearch: {} }], 'the grounded call must attach the search tool');
});

test('grounded: no grounding metadata → honest model-knowledge answer', async () => {
  stubGemini(() => new Response(PLAIN_REPLY('Sky appears blue because air scatters short wavelengths.'), { status: 200, headers: { 'content-type': 'application/json' } }));
  const res = await fetch(`${base}/miner/job-hunt`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'Why is the sky blue?' }),
  });
  const data = (await res.json()) as { label: string; confidence: number; reason: string };
  assert.equal(data.confidence, 0.65, 'ungrounded answers stay modest');
  assert.match(data.reason, /general knowledge, not live-sourced/);
});

test('pool: a 429 on one key rotates to the next within the same request', async () => {
  await freshPool();
  const calls: StubCall[] = [];
  stubGemini((call) => {
    calls.push(call);
    if (call.apiKey === 'test-key-AAAA1111') {
      return new Response(JSON.stringify({ error: { code: 429, message: 'quota exceeded' } }), { status: 429 });
    }
    return new Response(GROUNDED_REPLY('Answered via the second key.', [{ title: 's', uri: 'https://example.com/y' }]), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const res = await fetch(`${base}/miner/job-hunt`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'latest news about the EU' }),
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { label: string; confidence: number };
  assert.match(data.label, /second key/);
  assert.equal(calls.length, 2, 'one request, two key attempts — rotated, not failed');
  assert.equal(calls[0].apiKey, 'test-key-AAAA1111');
  assert.equal(calls[1].apiKey, 'test-key-BBBB2222');
  assert.ok(data.confidence > 0, 'the caller still gets a real answer after rotation');
});

test('pool: a rejected credential benches that key, not the pool', async () => {
  await freshPool();
  const calls: StubCall[] = [];
  stubGemini((call) => {
    calls.push(call);
    if (call.apiKey === 'test-key-AAAA1111') {
      return new Response(JSON.stringify({ error: { message: 'API key not valid. Please pass a valid API key.' } }), { status: 400 });
    }
    return new Response(GROUNDED_REPLY('Recovered on the healthy key.', [{ title: 's', uri: 'https://example.com/z' }]), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const res = await fetch(`${base}/miner/job-hunt`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'explain quantum tunneling' }),
  });
  const data = (await res.json()) as { label: string };
  assert.match(data.label, /healthy key/);
  assert.equal(calls.length, 2, 'bad key benched, request completed on the other');
});

test('grounded: tool-rejecting 400 falls back to a plain answer', async () => {
  await freshPool();
  const calls: StubCall[] = [];
  stubGemini((call) => {
    calls.push(call);
    if (call.tools) {
      // Some model versions reject the tool outright.
      return new Response(JSON.stringify({ error: { message: 'Tools are not supported for this model.' } }), { status: 400 });
    }
    return new Response(PLAIN_REPLY('Plain answer after tool fallback.'), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const res = await fetch(`${base}/miner/job-hunt`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'what causes tides' }),
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { label: string; confidence: number };
  assert.match(data.label, /Plain answer/);
  assert.equal(calls.length, 2, 'first with tools, retried without');
  assert.ok(calls[0].tools && !calls[1].tools);
});

test('pool: every key limited → the honest decline, never a crash', async () => {
  await freshPool();
  stubGemini(() => new Response(JSON.stringify({ error: { code: 429, message: 'quota' } }), { status: 429 }));
  const res = await fetch(`${base}/miner/job-hunt`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'who invented the telephone' }),
  });
  assert.equal(res.status, 200, 'never-fail surface: an exhausted pool still answers 200');
  const data = (await res.json()) as { label: string; confidence: number; match_count: number };
  assert.ok(data.label.length > 0);
  assert.ok(data.confidence <= 0.2, 'the decline is honest about its weakness');
});

test('health: reports the key pool', async () => {
  stubGemini(() => new Response(GROUNDED_REPLY('ok', [{ title: 's', uri: 'https://example.com' }]), { status: 200, headers: { 'content-type': 'application/json' } }));
  await fetch(`${base}/miner/job-hunt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: GENERAL_Q }) });
  const health = (await (await fetch(`${base}/health`)).json()) as { llm: { keyCount?: number; keysRateLimited?: number } };
  assert.equal(health.llm.keyCount, 2);
  assert.ok(typeof health.llm.keysRateLimited === 'number');
});
