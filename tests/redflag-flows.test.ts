/**
 * Redflag FLOW tests — every user-facing surface of the due-diligence
 * product, exercised end to end against the real HTTP server:
 *
 *   · the web demo page (GET /redflag)
 *   · the free preview (POST /api/redflag/preview): happy path, validation,
 *     and the per-client rate limit
 *   · the paid report gate (POST /api/redflag → 402 without payment)
 *   · the service catalog pricing
 *   · /health's telegraph consumer section
 *   · the standing-watch poller: due checks, alerting, fingerprint dedup,
 *     per-check and per-tick budgets, crash containment
 *   · persistence: reports and watches survive in SQLite
 *
 * All external services are off (hermetic): no LLM keys, mock job boards,
 * no Telegraph wallet — the watch tick injects its engine.
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

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { startServer } = await import('../src/server.js');
const {
  createWatch, deactivateWatch, getWatch, listActiveWatches, listWatches,
  saveRedflagReport, listRedflagReports, updateWatchAlert, updateWatchCheck,
} = await import('../src/db.js');
const { runWatchTick, isWatchDue, signalFingerprint, renderWatchAlert } = await import('../src/watch/watchPoller.js');

const server = startServer(0);
await new Promise<void>((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
test.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

// A distinct client key per test so the shared 3/hour preview limit never
// bleeds between tests (loopback clients are keyed on x-internal-client).
const client = (name: string): Record<string, string> => ({ 'x-internal-client': `test:${name}` });

// ── the web demo page ───────────────────────────────────────────────────────

test('web: GET /redflag serves the app page', async () => {
  const res = await fetch(`${base}/redflag`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const html = await res.text();
  // The page must reference its own endpoint and the full-vetting upgrade.
  assert.match(html, /\/api\/redflag\/preview/);
  assert.match(html, /Run free scan/);
  assert.match(html, /\/api\/redflag\/web/);
  // No unescaped script injection risk: the page is a static string.
  assert.ok(html.length > 2000);
});

test('web: GET /redflag/ (trailing slash) also serves the page', async () => {
  const res = await fetch(`${base}/redflag/`);
  assert.equal(res.status, 200);
});

// ── the free preview ────────────────────────────────────────────────────────

test('preview: scam posting returns avoid verdict with zero miner spend', async () => {
  const res = await fetch(`${base}/api/redflag/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...client('preview-scam') },
    body: JSON.stringify({
      text: 'Data Entry at Global Logistics Ltd\nEarn $600/day! No interview required. A $49 application fee covers your training kit. Contact us only via Telegram @quickhire.',
    }),
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as {
    ok: boolean; verdict: string; previewsRemainingThisHour: number;
    result: { flags: Array<{ severity: string }>; spendUsd: number; checks: Array<{ source: string; status: string }> };
  };
  assert.equal(data.ok, true);
  assert.equal(data.verdict, 'avoid', 'hard scam patterns drive the free verdict too');
  assert.equal(data.result.spendUsd, 0, 'the free tier never pays miners');
  assert.ok(data.result.flags.some((f) => f.severity === 'red'));
  // The four paid checks are listed as skipped — visible, not hidden.
  const paid = data.result.checks.filter((c) => c.source === 'telegraph');
  assert.equal(paid.length, 4);
  for (const check of paid) assert.equal(check.status, 'skipped');
});

test('preview: clean posting scans green and keeps its remaining-count', async () => {
  const res = await fetch(`${base}/api/redflag/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...client('preview-clean') },
    body: JSON.stringify({ company: 'TestCo', title: 'Senior Backend Engineer', description: 'TypeScript role, remote, $150k. Apply at jobs@testco.example.' }),
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { ok: boolean; previewsRemainingThisHour: number; result: { verdict: string } };
  assert.equal(data.ok, true);
  assert.notEqual(data.result.verdict, 'avoid');
  assert.ok(data.previewsRemainingThisHour >= 0 && data.previewsRemainingThisHour < 3);
});

test('preview: empty body is a clean 400 with guidance', async () => {
  const res = await fetch(`${base}/api/redflag/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...client('preview-empty') },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  const data = (await res.json()) as { error: string };
  assert.match(data.error, /paste a job posting/i);
});

test('preview: invalid JSON is a 400, not a crash', async () => {
  const res = await fetch(`${base}/api/redflag/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...client('preview-badjson') },
    body: 'not json{',
  });
  assert.equal(res.status, 400);
});

test('preview: rate limit trips at 3/hour per client', async () => {
  const key = client('preview-ratelimit');
  const post = (): Promise<Response> =>
    fetch(`${base}/api/redflag/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...key },
      body: JSON.stringify({ text: 'Engineer at RateLimitCo, remote role.' }),
    });
  const first = await post();
  const second = await post();
  const third = await post();
  assert.ok(first.ok && second.ok && third.ok);
  const fourth = await post();
  assert.equal(fourth.status, 429);
  const body = (await fourth.json()) as { retryAfterSeconds: number };
  assert.ok(body.retryAfterSeconds > 0);
});

// ── the paid gate ───────────────────────────────────────────────────────────

test('paid: /api/redflag demands payment before vetting', async () => {
  const res = await fetch(`${base}/api/redflag`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ company: 'Acme Corp', title: 'Engineer', description: 'TypeScript role' }),
  });
  assert.equal(res.status, 402);
  const data = (await res.json()) as { payment?: { priceUsd: string } };
  assert.equal(data.payment?.priceUsd, '0.05');
});

test('paid: catalog lists redflag at $0.05 alongside the others', async () => {
  const res = await fetch(`${base}/api/services`);
  const data = (await res.json()) as { services: Array<{ id: string; priceUsd: string }> };
  const redflag = data.services.find((s) => s.id === 'redflag-vetting');
  assert.ok(redflag);
  assert.equal(redflag!.priceUsd, '0.05');
});

test('health: reports the telegraph consumer side', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const data = (await res.json()) as { telegraph?: { configured: boolean; nodeUrl: string } };
  assert.equal(typeof data.telegraph?.configured, 'boolean');
  assert.ok(data.telegraph?.nodeUrl.includes('devnode'));
});

// ── persistence: reports and watches ────────────────────────────────────────

test('db: redflag reports persist and list newest-first', () => {
  saveRedflagReport({ id: 'r1', userId: 'u1', company: 'Acme', verdict: 'caution', spendUsd: 0.03, at: '2026-01-01T00:00:00Z', data: { label: 'x' } });
  saveRedflagReport({ id: 'r2', userId: 'u1', company: 'Beta', verdict: 'clear', spendUsd: 0.02, at: '2026-01-02T00:00:00Z', data: { label: 'y' } });
  saveRedflagReport({ id: 'r3', userId: 'u2', company: 'Gamma', verdict: 'avoid', spendUsd: 0.04, at: '2026-01-03T00:00:00Z', data: { label: 'z' } });
  const mine = listRedflagReports('u1', 5);
  assert.equal(mine.length, 2, 'per-user isolation');
  assert.equal(mine[0].company, 'Beta', 'newest first');
  assert.equal(mine[0].data.label, 'y', 'payload round-trips');
});

test('db: watch CRUD — create, list, deactivate', () => {
  const w = createWatch('u1', 'Stripe', 12345);
  assert.equal(w.active, true);
  assert.equal(w.chatId, 12345);
  assert.ok(listWatches('u1').some((x) => x.id === w.id));
  assert.ok(listActiveWatches().some((x) => x.id === w.id));
  assert.equal(deactivateWatch(w.id), true, 'deactivate reports the change');
  assert.equal(deactivateWatch(w.id), false, 'second deactivate is a no-op');
  assert.equal(listWatches('u1').length, 0, 'stopped watches vanish from the user list');
  assert.equal(getWatch(w.id)!.active, false, 'but the row is kept for audit');
});

// ── the watch poller ────────────────────────────────────────────────────────

test('watch: isWatchDue honours the interval', () => {
  const now = Date.parse('2026-01-02T12:00:00Z');
  assert.equal(isWatchDue(null, 6, now), true, 'never checked → due');
  assert.equal(isWatchDue('2026-01-02T11:00:00Z', 6, now), false, 'checked an hour ago → not due');
  assert.equal(isWatchDue('2026-01-02T06:00:00Z', 6, now), true, 'checked six hours ago → due');
});

test('watch: signalFingerprint changes only when coverage changes', () => {
  assert.equal(signalFingerprint('Acme layoffs announced'), signalFingerprint('acme layoffs announced  '), 'case/whitespace-insensitive');
  assert.notEqual(signalFingerprint('Acme layoffs announced'), signalFingerprint('Acme funding round closed'));
});

test('watch: tick buys one news check per due watch and alerts on new negative coverage', async () => {
  const watch = createWatch('tick-user-1', 'Acme Corp', 111);
  let asked = 0;
  const asks: string[] = [];
  const sent: Array<{ chatId: number; text: string }> = [];
  try {
    const result = await runWatchTick({
      ask: async (opts) => {
        asked += 1;
        asks.push(opts.query);
        return {
          ok: true, minerName: 'tavily', costUsd: 0.01, signalHash: '0x1',
          result: { results: [{ title: 'Acme layoffs', content: 'Acme Corp announced layoffs of 300 staff.' }] },
        };
      },
      send: async (chatId, text) => { sent.push({ chatId, text }); },
    });
    assert.equal(result.due, 1);
    assert.equal(result.checked, 1);
    assert.equal(result.alerted, 1, 'alarming new coverage alerts');
    assert.equal(result.spentUsd, 0.01);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, 111);
    assert.match(sent[0].text, /Acme Corp/);
    assert.match(asks[0] ?? '', /Latest news about Acme Corp/);
    // The stored fingerprint is of the DISTILLED text ("title — content"),
    // which is what the poller actually compares between ticks.
    assert.equal(getWatch(watch.id)!.lastAlertSignal, signalFingerprint('Acme layoffs — Acme Corp announced layoffs of 300 staff.'));
  } finally {
    deactivateWatch(watch.id);
  }
});

test('watch: the same story twice alerts only once', async () => {
  const watch = createWatch('tick-user-2', 'Beta Corp', 222);
  try {
    const evidence = { results: [{ title: 'Beta layoffs', content: 'Beta Corp announced layoffs today.' }] };
    const engine = async (): Promise<{ ok: boolean; minerName: string; costUsd: number; result: unknown }> =>
      ({ ok: true, minerName: 'tavily', costUsd: 0.01, result: evidence });
    const sent: string[] = [];
    const sender = async (_chatId: number, text: string): Promise<void> => { sent.push(text); };

    const first = await runWatchTick({ ask: engine, send: sender });
    // Force the next tick to see the watch as due again.
    await forceDue(watch.id);
    const second = await runWatchTick({ ask: engine, send: sender });

    assert.equal(first.alerted, 1);
    assert.equal(second.alerted, 0, 'identical fingerprint → no re-alert');
    assert.equal(second.checked, 1, 'the check still ran and was paid');
    assert.equal(sent.length, 1);
  } finally {
    deactivateWatch(watch.id);
  }
});

test('watch: quiet news never alerts', async () => {
  const watch = createWatch('tick-user-3', 'Quiet Corp', 333);
  try {
    const result = await runWatchTick({
      ask: async () => ({ ok: true, minerName: 'tavily', costUsd: 0.01, result: { results: [{ title: 'Quiet Corp ships v2', content: 'Product launch went smoothly.' }] } }),
      send: async () => { throw new Error('must not send'); },
    });
    assert.equal(result.checked, 1);
    assert.equal(result.alerted, 0);
    assert.equal(getWatch(watch.id)!.lastAlertSignal, null, 'no fingerprint recorded for quiet news');
  } finally {
    deactivateWatch(watch.id);
  }
});

test('watch: per-check budget declines over-priced checks without paying', async () => {
  const watch = createWatch('tick-user-4', 'Pricey Corp', 444);
  try {
    const result = await runWatchTick({
      ask: async (opts) => (opts.maxCostUsd !== undefined && 0.05 > opts.maxCostUsd
        ? { ok: false, skipped: true, error: 'priced over budget' }
        : { ok: true, minerName: 'x', costUsd: 0.05, result: {} }),
      checkBudgetUsd: 0.02,
      send: async () => { throw new Error('must not send'); },
    });
    assert.equal(result.checked, 0);
    assert.equal(result.skipped, 1);
    assert.equal(result.spentUsd, 0);
  } finally {
    deactivateWatch(watch.id);
  }
});

test('watch: tick budget stops buying after the ceiling', async () => {
  const created: string[] = [];
  for (const company of ['CorpA', 'CorpB', 'CorpC']) created.push(createWatch('tick-user-5', company, null).id);
  let calls = 0;
  try {
    const result = await runWatchTick({
      // Mirrors the real engine contract: a call priced above the maxCostUsd
      // the caller allows is declined BEFORE payment.
      ask: async (opts) => {
        if (opts.maxCostUsd !== undefined && 0.10 > opts.maxCostUsd) {
          return { ok: false, skipped: true, error: 'priced over budget' };
        }
        calls += 1;
        return { ok: true, minerName: 'x', costUsd: 0.10, result: { results: [{ title: 'fine', content: 'all good here' }] } };
      },
      checkBudgetUsd: 0.20,
      tickBudgetUsd: 0.15, // first check eats $0.10; the rest are over the remaining tick budget
      send: async () => {},
    });
    assert.equal(calls, 1, 'only one paid check went out');
    assert.equal(result.checked, 1);
    assert.equal(result.skipped, 2, 'remaining watches are skipped, not bought');
    assert.equal(result.spentUsd, 0.10);
  } finally {
    for (const id of created) deactivateWatch(id);
  }
});

test('watch: a throwing engine is contained and retried next tick', async () => {
  const watch = createWatch('tick-user-6', 'Broken Corp', null);
  try {
    const result = await runWatchTick({
      ask: async () => { throw new Error('engine exploded'); },
      send: async () => {},
    });
    const mine = result.errors.filter((e) => e.startsWith('Broken Corp'));
    assert.equal(mine.length, 1, 'this watch produced exactly one contained error');
    assert.match(mine[0]!, /engine exploded/);
    assert.equal(result.checked, 0);
    assert.equal(getWatch(watch.id)!.lastCheckAt !== null, true, 'attempt recorded so it is not instantly re-due');
  } finally {
    deactivateWatch(watch.id);
  }
});

test('watch: renderWatchAlert carries company, headline and miner provenance', () => {
  const text = renderWatchAlert('Acme', 'Acme announced layoffs of 300 staff.', 'tavily', 0.01);
  assert.match(text, /Acme/);
  assert.match(text, /layoffs/);
  assert.match(text, /tavily/);
  assert.match(text, /\$0\.01/);
});

/** Clear last_check_at so a watch is immediately due again. */
async function forceDue(watchId: string): Promise<void> {
  const { db } = await import('../src/db.js');
  db.prepare('UPDATE redflag_watches SET last_check_at = NULL WHERE id = ?').run(watchId);
}

// ── the miner surface still works alongside everything ─────────────────────

test('miner: routes stay healthy after all redflag additions', async () => {
  const res = await fetch(`${base}/miner/job-hunt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'backend engineer jobs, remote' }),
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { label: string; matches: unknown[] };
  assert.ok(data.label.length > 0);
});
