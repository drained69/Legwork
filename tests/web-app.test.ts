/**
 * The expanded web-app tests — both sides of the flywheel:
 *
 *   · the free hunt tool (POST /api/hunt/web): the miner's own signal served
 *     to the web, including rate limiting and validation
 *   · the page at / (root) as well as /redflag
 *   · stats: per-miner network panel + visit counting
 *   · report pages: OG/Twitter meta for social sharing, share buttons
 *   · WEB WATCHES: start from the report page, poller tick appends the
 *     finding to the report (the page is the inbox), unwatch stops
 *
 * The engine node is a local stub (same contract as redflag-web.test.ts), so
 * the full consumer pipeline runs hermetically with zero real spend.
 */
process.env.DATABASE_PATH = ':memory:';
process.env.ANTHROPIC_API_KEY = '';
process.env.ANTHROPIC_AUTH_TOKEN = '';
process.env.ANTHROPIC_BASE_URL = '';
process.env.GEMINI_API_KEY = '';
process.env.GOOGLE_API_KEY = '';
process.env.GEMINI_API_KEY_2 = '';
process.env.ADZUNA_APP_ID = '';
process.env.ADZUNA_APP_KEY = '';
process.env.USAJOBS_API_KEY = '';
process.env.REMOTIVE_ENABLED = 'false';
process.env.TELEGRAPH_PRIVATE_KEY = `0x${'22'.repeat(32)}`;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';

function startStubNode(): Promise<Server> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk; });
    req.on('end', () => {
      const query = String((JSON.parse(body || '{}') as { query?: string }).query ?? '').toLowerCase();
      const miner = /phishing|scan this url/.test(query) ? 'stub-urlscan-miner'
        : /latest news/.test(query) ? 'stub-news-miner'
          : /fact-check/.test(query) ? 'stub-facts-miner'
            : 'stub-fraud-miner';
      const answer = miner === 'stub-news-miner'
        ? { label: 'No negative coverage', reason: 'Routine product and hiring news; nothing alarming found.' }
        : { label: 'No risk indicators', reason: 'Checked; nothing alarming found.' };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        miner_id: '9901', miner_name: miner, intent: 'X', result: answer,
        cost_usd: 0.01, duration_ms: 5, signal_hash: `0x${miner.replace(/[^a-z]/g, '').padEnd(12, '0').slice(0, 12)}`,
      }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const stubNode = await startStubNode();
process.env.TELEGRAPH_NODE_URL = `http://127.0.0.1:${(stubNode.address() as { port: number }).port}`;

const { startServer } = await import('../src/server.js');
const { runWatchTick } = await import('../src/watch/watchPoller.js');

const server = startServer(0);
await new Promise<void>((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => stubNode.close(() => resolve()));
});

const client = (name: string): Record<string, string> => ({ 'x-internal-client': `test:${name}` });
const post = async (path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; data: any }> => {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

// ── the free hunt tool ───────────────────────────────────────────────────────

test('hunt/web: a job query returns the miner signal with live-shaped matches', async () => {
  const { status, data } = await post('/api/hunt/web', { query: 'senior backend engineer, TypeScript, remote, $120k+' }, client('hunt-1'));
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(data.signal.label.length > 0, 'the signal label resolves');
  assert.ok(Array.isArray(data.signal.matches), 'matches array present');
  assert.ok(data.signal.confidence > 0 && data.signal.confidence <= 1);
  // The mock board's scored shortlist is exactly what the miner would serve.
  for (const m of data.signal.matches) {
    assert.ok(typeof m.score === 'number' && m.title && m.company && m.url, 'every match is renderable');
  }
  assert.ok(data.huntsRemainingThisHour >= 0 && data.huntsRemainingThisHour < 6);
});

test('hunt/web: a pay question is answered honestly (answer shape, not a 400)', async () => {
  const { status, data } = await post('/api/hunt/web', { query: 'what does a data analyst earn in New York' }, client('hunt-2'));
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  // Keyless mocks carry no on-topic salary data: the honest decline or a
  // synthesized median — either is a real answer, never an error.
  assert.match(data.signal.label, /median|Not enough advertised salaries|matching roles/i);
  assert.equal(data.signal.match_count ?? 0, data.signal.matches?.length ?? 0);
});

test('hunt/web: empty and oversized queries are clean 400s', async () => {
  const empty = await post('/api/hunt/web', {}, client('hunt-3'));
  assert.equal(empty.status, 400);
  assert.match(empty.data.error, /type a job search/i);
  const long = await post('/api/hunt/web', { query: 'x'.repeat(2500) }, client('hunt-3'));
  assert.equal(long.status, 400);
});

test('hunt/web: rate limit trips at 6/hour per client', async () => {
  const key = client('hunt-rl');
  for (let i = 0; i < 6; i++) {
    const res = await post('/api/hunt/web', { query: 'backend engineer jobs, remote' }, key);
    assert.equal(res.status, 200, `call ${i + 1} should pass`);
  }
  const seventh = await post('/api/hunt/web', { query: 'backend engineer jobs, remote' }, key);
  assert.equal(seventh.status, 429);
  assert.ok(seventh.data.retryAfterSeconds > 0);
});

// ── the page and its wiring ──────────────────────────────────────────────────

test('page: served at / AND /redflag, with both tools wired', async () => {
  for (const path of ['/', '/redflag']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200, `${path} must serve the app`);
    const html = await res.text();
    assert.match(html, /Find jobs worth applying to/);
    assert.match(html, /Vet an offer/);
    assert.match(html, /\/api\/hunt\/web/);
    assert.match(html, /\/api\/redflag\/web/);
    assert.match(html, /Miners we've bought from/);
    assert.match(html, /og:title/);
  }
});

// ── a full vetting to have a report + ledger entries ─────────────────────────

let reportId = '';

test('vetting: the full web vetting still works (stub miners) and yields a share URL', async () => {
  const { status, data } = await post('/api/redflag/web', { text: 'Senior Backend Engineer at Stripe\nRemote, $180k–$220k. Apply at https://stripe.com/jobs/search' }, client('full-1'));
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  reportId = String(data.shareUrl).split('/report/')[1] ?? '';
  assert.match(reportId, /^[0-9a-f-]{36}$/);
});

test('stats: per-miner network panel and visit counting', async () => {
  // Visits: two page loads above (/ and /redflag) plus this file's report GETs.
  const stats = (await (await fetch(`${base}/api/stats`)).json()) as {
    ok: boolean; perMiner: Array<{ miner: string; checks: number; costUsd: number }>; visits: { total: number; last24h: number };
  };
  assert.equal(stats.ok, true);
  assert.ok(stats.perMiner.length >= 1, 'the panel lists the stub miners');
  assert.ok(stats.perMiner.every((m) => m.miner.startsWith('stub-') && m.checks >= 1));
  assert.ok(stats.visits.total >= 2, `visits are counted, got ${stats.visits.total}`);
  assert.ok(stats.visits.last24h >= 2);
});

// ── report pages: share-ready ────────────────────────────────────────────────

test('report page: OG/Twitter meta, share buttons, watch controls', async () => {
  assert.ok(reportId, 'previous vetting must have produced a report');
  const res = await fetch(`${base}/report/${reportId}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /og:title/);
  assert.match(html, /og:description/);
  assert.match(html, /twitter:card/);
  assert.match(html, /Post on X/);
  assert.match(html, /LinkedIn/);
  assert.match(html, /Copy link/);
  assert.match(html, /Watch Stripe/, 'the watch button names the company');
});

// ── web watches: the page is the inbox ───────────────────────────────────────

test('watch: starts from the report page, dedupes, and is idempotent', async () => {
  const first = await post(`/api/report/${reportId}/watch`, {});
  assert.equal(first.status, 200);
  assert.equal(first.data.ok, true);
  assert.ok(first.data.watchId);
  assert.equal(first.data.intervalHours, 6);
  const second = await post(`/api/report/${reportId}/watch`, {});
  assert.equal(second.status, 200);
  assert.equal(second.data.alreadyWatching, true, 'one watch per report');
});

test('watch: the poller tick appends new negative coverage TO THE REPORT', async () => {
  const tick = await runWatchTick({
    ask: async () => ({
      ok: true, minerName: 'stub-news-miner', costUsd: 0.01,
      result: { label: 'Negative coverage', reason: 'Stripe announced layoffs of 300 staff today.' },
    }),
    send: async () => { throw new Error('web watches must never send to Telegram'); },
  });
  assert.equal(tick.checked, 1);
  assert.equal(tick.alerted, 1, 'the web watch delivered by appending, not by sending');

  const html = await (await fetch(`${base}/report/${reportId}`)).text();
  assert.match(html, /Since your vetting/, 'the updates section renders');
  assert.match(html, /layoffs/);
  assert.match(html, /stub-news-miner/);
  // Quiet re-check with the same evidence must not re-alert (fingerprint dedupe).
  const again = await runWatchTick({
    ask: async () => ({
      ok: true, minerName: 'stub-news-miner', costUsd: 0.01,
      result: { label: 'Negative coverage', reason: 'Stripe announced layoffs of 300 staff today.' },
    }),
    send: async () => { throw new Error('must not send'); },
  });
  assert.equal(again.alerted, 0, 'same story twice never alerts twice');
});

test('watch: unwatch stops it, and the report page reflects the state', async () => {
  const res = await post(`/api/report/${reportId}/unwatch`, {});
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
  const api = (await (await fetch(`${base}/api/report/${reportId}`)).json()) as { watch?: { active: boolean } };
  assert.equal(api.watch, undefined, 'no active watch after unwatch');
  const html = await (await fetch(`${base}/report/${reportId}`)).text();
  assert.match(html, /Watch Stripe/, 'the watch button is back');
});

test('watch: unknown reports and unconfigured wallets degrade honestly', async () => {
  const missing = await post('/api/report/00000000-0000-4000-8000-000000000000/watch', {});
  assert.equal(missing.status, 404);
  // A second report, created with the wallet "unavailable" — verified by the
  // dedicated subprocess check in redflag-web.test.ts; here assert the route
  // shape only (503 path needs a fresh process).
  const shape = await post('/api/report/not-a-uuid/watch', {});
  assert.equal(shape.status, 404);
});
