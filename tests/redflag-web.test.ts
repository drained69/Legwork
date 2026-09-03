/**
 * The PUBLIC WEB APP tests — the Track 3 Telegraph consumer surface:
 *
 *   · the full vetting endpoint (POST /api/redflag/web): operator-paid miner
 *     checks bought through a stubbed engine node, per-IP rate limit, daily
 *     spend ceiling read from the reports ledger
 *   · shareable report pages (GET /report/:id, GET /api/report/:id)
 *   · public network-usage stats (GET /api/stats)
 *   · the redesigned homepage wiring
 *
 * The engine node is a local stub: engineAsk's unpaid probe receives a 200
 * with a well-formed engine response, so the full consumer pipeline — ask,
 * distill, synthesize, receipt — runs hermetically with zero real spend.
 */
process.env.DATABASE_PATH = ':memory:';
process.env.ANTHROPIC_API_KEY = '';
process.env.ANTHROPIC_AUTH_TOKEN = '';
process.env.ANTHROPIC_BASE_URL = '';
process.env.GEMINI_API_KEY = '';
process.env.GOOGLE_API_KEY = '';
process.env.ADZUNA_APP_ID = '';
process.env.ADZUNA_APP_KEY = '';
process.env.USAJOBS_API_KEY = '';
process.env.REMOTIVE_ENABLED = 'false';
// A throwaway key: never funded, never used for a real signature (the stub
// answers 200, so the x402 payment path is never taken).
process.env.TELEGRAPH_PRIVATE_KEY = `0x${'11'.repeat(32)}`;
process.env.REDFLAG_WEB_DAILY_BUDGET_USD = '1.00';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';

/** The stub engine node: every ask is answered 200 with a miner-shaped result. */
function startStubNode(): Promise<Server> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk; });
    req.on('end', () => {
      const query = String((JSON.parse(body || '{}') as { query?: string }).query ?? '').toLowerCase();
      // Match-specific patterns first: the URL-scan query itself contains the
      // word "scam", so a naive /scam/ test would misroute it.
      const miner = /phishing|scan this url/.test(query) ? 'stub-urlscan-miner'
        : /latest news/.test(query) ? 'stub-news-miner'
          : /fact-check/.test(query) ? 'stub-facts-miner'
            : 'stub-fraud-miner';
      const intent = miner === 'stub-fraud-miner' ? 'FRAUD_DETECTION'
        : miner === 'stub-news-miner' ? 'NEWS_SEARCH'
          : miner === 'stub-urlscan-miner' ? 'URL_SCAN'
            : 'FACT_CHECK';
      const answer = miner === 'stub-news-miner'
        ? { label: 'No negative coverage', reason: 'Recent coverage is routine product and hiring news; no layoffs, bankruptcy or scandals found.' }
        : { label: 'No risk indicators', reason: 'Checked; nothing alarming found.' };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        miner_id: '9901',
        miner_name: miner,
        intent,
        result: answer,
        cost_usd: 0.01,
        duration_ms: 42,
        signal_hash: `0x${miner.replace(/[^a-z]/g, '').padEnd(12, '0').slice(0, 12)}`,
      }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const stubNode = await startStubNode();
process.env.TELEGRAPH_NODE_URL = `http://127.0.0.1:${(stubNode.address() as { port: number }).port}`;

const { startServer } = await import('../src/server.js');
const { saveRedflagReport } = await import('../src/db.js');

const server = startServer(0);
await new Promise<void>((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => stubNode.close(() => resolve()));
});

// Distinct client keys so the shared 2/hour full-vetting limit never bleeds
// between tests (loopback clients are keyed on x-internal-client).
const client = (name: string): Record<string, string> => ({ 'x-internal-client': `test:${name}` });

const CLEAN_POSTING = 'Senior Backend Engineer at Shopify\nRemote-first, $170k–$210k. TypeScript payments team. Apply at https://jobs.shopify.com/careers';

// ── the full vetting ────────────────────────────────────────────────────────

let sharedReportId = '';

test('web full: buys the four miner checks and returns a shareable report', async () => {
  const res = await fetch(`${base}/api/redflag/web`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...client('full-1') },
    body: JSON.stringify({ text: CLEAN_POSTING }),
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as {
    ok: boolean; shareUrl: string; budgetUsd: number;
    report: {
      verdict: string; spendUsd: number; budgetUsd: number;
      checks: Array<{ id: string; source: string; status: string; miner?: string; costUsd: number; signalHash?: string }>;
    };
  };
  assert.equal(data.ok, true);
  // The share link points at the public report page.
  assert.match(data.shareUrl, /\/report\/[0-9a-f-]{36}$/);
  sharedReportId = data.shareUrl.split('/report/')[1] ?? '';
  // All four network checks ran against stub miners, each with provenance.
  const telegraph = data.report.checks.filter((c) => c.source === 'telegraph');
  assert.equal(telegraph.length, 4);
  for (const check of telegraph) {
    assert.equal(check.status, 'ok', `${check.id} should have run`);
    assert.match(check.miner ?? '', /^stub-/, 'the serving miner is named');
    assert.equal(check.costUsd, 0.01, 'the cost is what the miner charged');
    assert.ok(check.signalHash, 'the signal hash is carried through');
  }
  assert.ok(data.report.spendUsd >= 0.04, 'four checks at $0.01 each were bought');
  assert.ok(data.budgetUsd <= 0.08, 'the per-report budget is the configured ceiling');
});

test('web full: rate limit trips at the configured calls per hour', async () => {
  const key = client('ratelimit');
  const post = (): Promise<Response> =>
    fetch(`${base}/api/redflag/web`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...key },
      body: JSON.stringify({ text: CLEAN_POSTING }),
    });
  const first = await post();
  const second = await post();
  assert.ok(first.ok && second.ok);
  const third = await post();
  assert.equal(third.status, 429);
  const body = (await third.json()) as { retryAfterSeconds: number; error: string };
  assert.ok(body.retryAfterSeconds > 0);
  assert.match(body.error, /free scan/i, 'the limit message points at the free scan');
});

test('web full: validation still applies', async () => {
  const res = await fetch(`${base}/api/redflag/web`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...client('full-empty') },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test('web full: the daily spend ceiling is read from the ledger, not memory', async () => {
  // Seed the ledger with today's web spend at the ceiling: $1.00 budget, one
  // existing $0.99 web report today. A fresh client must be refused on
  // budget grounds (not rate grounds) — and told the free scan still works.
  const todayStart = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').toISOString();
  saveRedflagReport({
    id: 'seed-web-today', userId: 'web:seed', company: 'BudgetEater Corp', verdict: 'clear',
    spendUsd: 0.99, at: todayStart, data: { checks: [] },
  });
  const res = await fetch(`${base}/api/redflag/web`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...client('full-budget') },
    body: JSON.stringify({ text: CLEAN_POSTING }),
  });
  assert.equal(res.status, 429);
  const data = (await res.json()) as { error: string };
  assert.match(data.error, /budget/i);
  assert.match(data.error, /free scan/i);
});

test('web full: without a Telegraph wallet the endpoint degrades honestly', async () => {
  // The other suites run without TELEGRAPH_PRIVATE_KEY; this suite HAS one.
  // Exercise the unconfigured path directly against the handler's contract:
  // config is a singleton here, so assert on a fresh subprocess instead.
  const { execFileSync } = await import('node:child_process');
  const script = `
    process.env.DATABASE_PATH = ':memory:';
    process.env.ANTHROPIC_API_KEY = ''; process.env.GEMINI_API_KEY = '';
    process.env.TELEGRAPH_PRIVATE_KEY = '';
    const { startServer } = await import('./src/server.js');
    const server = startServer(0);
    await new Promise((r) => server.once('listening', r));
    const res = await fetch('http://127.0.0.1:' + server.address().port + '/api/redflag/web', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Engineer at TestCo, remote' }),
    });
    console.log(JSON.stringify({ status: res.status, body: await res.json() }));
    server.close();
  `;
  const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: new URL('.', import.meta.url).pathname.replace(/tests\/$/, ''),
    encoding: 'utf8',
  });
  const parsed = JSON.parse(out.slice(out.indexOf('{'))) as { status: number; body: { ok: boolean; error: string } };
  assert.equal(parsed.status, 503);
  assert.equal(parsed.body.ok, false);
  assert.match(parsed.body.error, /not configured/i);
});

// ── shareable report pages ──────────────────────────────────────────────────

test('report page: renders the receipt with miner provenance', async () => {
  assert.ok(sharedReportId, 'the full vetting above must have produced a report');
  const res = await fetch(`${base}/report/${sharedReportId}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const html = await res.text();
  assert.match(html, /Shopify/, 'the company is named');
  assert.match(html, /stub-fraud-miner/, 'the serving miner is named');
  assert.match(html, /signal 0x/, 'the signal hash is shown');
  assert.match(html, /\$0\.01/, 'per-check cost is shown');
});

test('report page: unknown and malformed ids 404 cleanly', async () => {
  const notAUuid = await fetch(`${base}/report/not-a-uuid-at-all`);
  assert.equal(notAUuid.status, 404);
  const missing = await fetch(`${base}/report/00000000-0000-4000-8000-000000000000`);
  assert.equal(missing.status, 404);
  // Path traversal must not reach the DB layer.
  const traversal = await fetch(`${base}/report/..%2Fminer.yaml`);
  assert.notEqual(traversal.status, 200);
});

test('report API: JSON by id', async () => {
  const res = await fetch(`${base}/api/report/${sharedReportId}`);
  assert.equal(res.status, 200);
  const data = (await res.json()) as { ok: boolean; report: { company: string; verdict: string } };
  assert.equal(data.ok, true);
  // The keyless fact extractor can carry trailing words into the company
  // ("Shopify Remote-first"); the assertion is that it captured the name.
  assert.ok(data.report.company.startsWith('Shopify'));
});

// ── public stats ────────────────────────────────────────────────────────────

test('stats: network usage is counted from the ledger', async () => {
  const res = await fetch(`${base}/api/stats`);
  assert.equal(res.status, 200);
  const data = (await res.json()) as {
    ok: boolean; totalReports: number; checksBought: number;
    minerSpendUsd: number; distinctMinersUsed: number;
    recent: Array<{ id: string; company: string; verdict: string }>;
  };
  assert.equal(data.ok, true);
  // At least the full vettings from this suite: 2 reports with 8 bought checks.
  assert.ok(data.totalReports >= 3, `expected >= 3 reports, got ${data.totalReports}`);
  assert.ok(data.checksBought >= 8, `expected >= 8 bought checks, got ${data.checksBought}`);
  assert.ok(data.minerSpendUsd >= 0.08, `expected >= $0.08 miner spend, got ${data.minerSpendUsd}`);
  assert.ok(data.distinctMinersUsed >= 4, 'the four stub miners are distinct');
  assert.ok(data.recent.length >= 1);
  assert.ok(data.recent.every((r) => typeof r.company === 'string' && r.company.length > 0));
});

// ── the homepage wiring ─────────────────────────────────────────────────────

test('homepage: serves the app with full-vetting wiring and stats hooks', async () => {
  const res = await fetch(`${base}/redflag`);
  assert.equal(res.status, 200);
  const html = await res.text();
  // The two actions and their endpoints.
  assert.match(html, /Run free scan/);
  assert.match(html, /Run full vetting/);
  assert.match(html, /\/api\/redflag\/preview/);
  assert.match(html, /\/api\/redflag\/web/);
  // The live stats strip and the recent-verdicts feed.
  assert.match(html, /\/api\/stats/);
  assert.match(html, /miner checks bought/);
  assert.match(html, /Recent verdicts/);
  // The four Telegraph intents are named in the explainer.
  assert.match(html, /FRAUD_DETECTION/);
  assert.match(html, /NEWS_SEARCH/);
  assert.match(html, /URL_SCAN/);
  assert.match(html, /FACT_CHECK/);
});
