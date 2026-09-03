/**
 * Local check with the REAL LLM: general questions and general writing must
 * produce direct model answers (the epoch-scoring fix), while job queries
 * keep the live-board specialty.
 */
import 'dotenv/config';
process.env.DATABASE_PATH = '/tmp/legwork-llm-check.db';
process.env.PORT = '0';

import { rmSync } from 'node:fs';

rmSync(process.env.DATABASE_PATH!, { force: true });
const { startServer } = await import('../src/server.js');
const server = startServer(0);
await new Promise<void>((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const probes: Array<{ name: string; body: unknown }> = [
  { name: 'general question (WEB_SEARCH probe shape)', body: { query: 'What role does the Federal Reserve play in inflation?' } },
  { name: 'general skill question', body: { query: 'What is Python?' } },
  { name: 'job search (must stay live-board)', body: { query: 'remote software engineering jobs' } },
  { name: 'pay question (must stay live synthesis)', body: { query: 'what does a data analyst earn in New York' } },
  { name: 'general writing (TEXT_GENERATION)', body: { prompt: 'Write a haiku about the ocean.' } },
  { name: 'job writing (must stay career writer)', body: { prompt: 'write a cover letter for a senior backend engineer position at Acme Corp' } },
];

for (const probe of probes) {
  const endpoint = 'query' in probe.body ? '/miner/job-hunt' : '/miner/tailor';
  const t = Date.now();
  const res = await fetch(`${base}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(probe.body),
  });
  const data = (await res.json()) as { label: string; confidence: number; match_count: number; generatedText?: string };
  const kind = data.match_count && data.match_count > 0 ? `JOB (${data.match_count} matches)` : data.generatedText ? 'DOC' : 'ANSWER';
  console.log(`\n✓ ${probe.name} [${Date.now() - t}ms] ${kind} conf=${data.confidence}`);
  console.log(`   ${data.label.slice(0, 140)}`);
}

await new Promise<void>((resolve) => server.close(() => resolve()));
console.log('\nLLM CHECK DONE');
