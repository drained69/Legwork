/**
 * Groq provider — the reliable-capacity backend.
 *
 * Groq speaks the OpenAI chat/completions schema (messages[], choices[0]
 * .message.content, bearer auth), unlike Gemini and Anthropic. These tests run
 * with ONLY a Groq key configured, stub the Groq endpoint, and assert routing,
 * request shape, response parsing, and transient-retry — so the provider is
 * proven before a real key is ever added.
 */
process.env.DATABASE_PATH = ':memory:';
// Groq only — every other provider cleared so the pool can't leak in.
process.env.GROQ_API_KEY = 'test-groq-key';
process.env.GEMINI_API_KEY = '';
process.env.GEMINI_API_KEY_2 = '';
process.env.GEMINI_API_KEY_3 = '';
process.env.GEMINI_API_KEY_4 = '';
process.env.GOOGLE_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.ANTHROPIC_AUTH_TOKEN = '';
process.env.ANTHROPIC_BASE_URL = '';
process.env.ADZUNA_APP_ID = '';
process.env.ADZUNA_APP_KEY = '';
process.env.USAJOBS_API_KEY = '';
process.env.REMOTIVE_ENABLED = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { startServer } = await import('../../src/server.js');
const { llmProvider } = await import('../../src/config.js');
const { llmHealth } = await import('../../src/llm.js');

const server = startServer(0);
await new Promise<void>((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
test.after(() => new Promise<void>((resolve) => server.close(() => resolve)));

interface GroqCall { url: string; auth: string; body: { model?: string; messages?: Array<{ role: string; content: string }>; max_tokens?: number } }

/** Intercept ONLY the Groq endpoint; `respond` decides the reply per call. */
function stubGroq(respond: (call: GroqCall, n: number) => Response): GroqCall[] {
  const realFetch = globalThis.fetch;
  const calls: GroqCall[] = [];
  let n = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes('api.groq.com')) return realFetch(input, init);
    n += 1;
    const headers = new Headers(init?.headers);
    const call: GroqCall = { url, auth: String(headers.get('authorization') ?? ''), body: JSON.parse(String(init?.body ?? '{}')) };
    calls.push(call);
    return respond(call, n);
  }) as typeof fetch;
  return calls;
}

const REPLY = (content: string): string => JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] });

test('groq is selected as the provider when its key is set', () => {
  assert.equal(llmProvider(), 'groq');
  const h = llmHealth();
  assert.equal(h.provider, 'groq');
  assert.equal(h.configured, true);
  assert.equal(h.authStyle, 'bearer');
  assert.match(h.endpoint, /api\.groq\.com/);
});

test('groq: a general question routes to Groq with the OpenAI schema and is answered', async () => {
  const calls = stubGroq(() =>
    new Response(REPLY('The capital of Japan is Tokyo.'), { status: 200, headers: { 'content-type': 'application/json' } }));
  const res = await fetch(`${base}/miner/job-hunt`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'what is the capital of Japan' }),
  });
  const data = (await res.json()) as { label: string; confidence: number };
  assert.ok(calls.length >= 1, 'the Groq endpoint was called');
  const c = calls[0];
  assert.match(c.url, /\/chat\/completions$/, 'OpenAI chat/completions path');
  assert.equal(c.auth, 'Bearer test-groq-key', 'bearer auth');
  assert.ok(Array.isArray(c.body.messages) && c.body.messages.some((m) => m.role === 'system') && c.body.messages.some((m) => m.role === 'user'), 'system + user messages');
  assert.equal(c.body.messages?.[0]?.role, 'system');
  assert.match(data.label, /Tokyo/, 'the answer is parsed from choices[0].message.content');
  assert.ok(data.confidence > 0.2, `real answer, not a 0.15 decline (got ${data.confidence})`);
});

test('groq: a transient 503 is retried, not surrendered to a decline', async () => {
  let n = 0;
  const calls = stubGroq(() => {
    n += 1;
    if (n === 1) return new Response(JSON.stringify({ error: { message: 'over capacity' } }), { status: 503 });
    return new Response(REPLY('Paris is the capital of France.'), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const res = await fetch(`${base}/miner/job-hunt`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'what is the capital of France' }),
  });
  const data = (await res.json()) as { label: string; confidence: number };
  assert.ok(calls.length >= 2, `retried after the 503 (calls=${calls.length})`);
  assert.match(data.label, /Paris/);
  assert.ok(data.confidence > 0.2);
});
