/**
 * Supplementary E2E — covers the restructure-relevant surfaces the other
 * check scripts miss, all FREE (no Telegraph spend):
 *   1. POST /api/hunt/web — the Track 3 web hunt tool (runs the miner signal)
 *   2. Web watch lifecycle: watch → report reflection → unwatch
 *   3. Miner never-fail hardening: malformed JSON, unknown path, oversized body
 *   4. ETH price retest (CoinGecko live)
 *   5. The stale-assertion fix: /redflag contains the redesigned copy
 */
import 'dotenv/config';
process.env.TELEGRAPH_PRIVATE_KEY ||= process.env.EVM_PRIVATE_KEY ?? '';
process.env.DATABASE_PATH = '/tmp/legwork-supplement.db';
process.env.PORT = '0';

import { rmSync } from 'node:fs';
rmSync(process.env.DATABASE_PATH, { force: true });
const { config } = await import('../src/config.js');
const { startServer } = await import('../src/server.js');
const { saveRedflagReport } = await import('../src/db.js');

const fails: string[] = [];
const ok = (name: string, cond: boolean, detail = ''): void => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) fails.push(name);
};

const server = startServer(0);
await new Promise<void>((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const client = (name: string) => ({ 'x-internal-client': `sup:${name}` });
const post = async (path: string, body: unknown, headers: Record<string, string> = {}, raw?: string): Promise<{ status: number; data: any; text: string }> => {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw ?? JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, data: (() => { try { return JSON.parse(text); } catch { return {}; } })(), text };
};

// ── 1. Track 3 web hunt tool ────────────────────────────────────────────────
const hunt = await post('/api/hunt/web', { query: 'registered nurse jobs in Austin' }, client('hunt'));
ok('POST /api/hunt/web runs the miner signal, free', hunt.status === 200 && hunt.data.ok === true && hunt.data.signal?.matches?.length >= 1, `${hunt.data.signal?.matches?.length} matches, conf ${hunt.data.signal?.confidence}`);
ok('  hunts-remaining metered', typeof hunt.data.huntsRemainingThisHour === 'number');
const huntEmpty = await post('/api/hunt/web', {}, client('hunt2'));
ok('  empty query rejected cleanly', huntEmpty.status === 400 && huntEmpty.data.ok === false);

// ── 2. web watch lifecycle (report page as the inbox) ───────────────────────
const rec = saveRedflagReport({ id: '11111111-2222-3333-4444-555555555555', userId: 'sup:test', company: 'SupTestCo', verdict: 'caution', spendUsd: 0.01, at: new Date().toISOString(), data: { checks: [] } });
const watchOn = await post('/api/report/11111111-2222-3333-4444-555555555555/watch', {}, client('watch'));
ok('POST /api/report/:id/watch starts a standing watch', watchOn.status === 200 && watchOn.data.ok === true && (watchOn.data.watchId || watchOn.data.alreadyWatching), JSON.stringify(watchOn.data).slice(0, 80));
const pageAfter = await (await fetch(`${base}/report/11111111-2222-3333-4444-555555555555`)).text();
ok('  report page reflects the active watch', /watching|unwatch|stop/i.test(pageAfter));
const watchOff = await post('/api/report/11111111-2222-3333-4444-555555555555/unwatch', {}, client('watch'));
ok('POST /api/report/:id/unwatch stops it', watchOff.status === 200 && watchOff.data.stopped === true);
const watchOffAgain = await post('/api/report/11111111-2222-3333-4444-555555555555/unwatch', {}, client('watch'));
ok('  unwatch on a watchless report 404s', watchOffAgain.status === 404);

// ── 3. miner never-fail surface ─────────────────────────────────────────────
const malformed = await post('/miner/job-hunt', undefined, {}, '{{{not json,,,');
ok('miner: malformed JSON still answers 200', malformed.status === 200 && typeof malformed.data.confidence === 'number', `conf ${malformed.data.confidence}`);
const unknown = await post('/miner/definitely-not-an-endpoint', { query: 'backend engineer jobs' });
ok('miner: unknown /miner/* path routes on body shape', unknown.status === 200 && typeof unknown.data.confidence === 'number');
// Oversized body: readBodyTruncating destroys the socket past 1MB and answers
// from the truncated prefix — the sending client typically sees ECONNRESET
// mid-upload, so assert the SERVER-side contract instead: under the limit it
// answers 200, and it keeps serving after an over-limit upload.
const underLimit = await post('/miner/tailor', { prompt: `write a cover letter ${'a'.repeat(50_000)}` });
ok('miner: large-but-under-limit body answers 200', underLimit.status === 200 && typeof underLimit.data.confidence === 'number');
try {
  await post('/miner/tailor', undefined, {}, 'x'.repeat(1_200_000));
} catch {
  // expected: connection reset while the server truncates
}
const afterOverlimit = await post('/miner/tailor', { prompt: 'write a cover letter for a nurse position' }, client('after'));
ok('miner: server healthy after over-limit upload (truncation path)', afterOverlimit.status === 200 && typeof afterOverlimit.data.confidence === 'number');
const getProbe = await fetch(`${base}/miner/job-hunt`);
ok('miner: body-less GET probe answers 200', getProbe.status === 200);

// ── 4. ETH price retest (CoinGecko, live) ───────────────────────────────────
const eth = await post('/miner/job-hunt', { query: 'What is the current price of Ethereum in US dollars?' });
ok('miner: current ETH price from LIVE market data (e2e flake retest)', eth.status === 200 && /Ethereum price: \$[\d,]+/.test(eth.data.label), eth.data.label.slice(0, 90));

// ── 5. redesigned page copy (stale-assertion fix) ───────────────────────────
const page = await fetch(`${base}/redflag`);
const html = await page.text();
ok('GET /redflag serves the redesigned app', page.status === 200 && html.includes('Run verification') && html.includes('/api/stats'));

console.log('');
await new Promise<void>((resolve) => server.close(() => resolve()));
if (fails.length) {
  console.error(`\n${fails.length} SUPPLEMENTARY FAILURE(S):\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
console.log('SUPPLEMENTARY E2E PASSED');
process.exit(0);
