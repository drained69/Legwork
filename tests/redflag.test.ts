/**
 * Redflag — the due-diligence product built on live Telegraph miners.
 *
 * Runs fully hermetic: no Telegraph wallet (paid checks are injected or
 * reported skipped), mock job boards, no LLM key (deterministic fallbacks) —
 * exactly the degraded paths production falls back to.
 */
process.env.DATABASE_PATH = ':memory:';
process.env.ANTHROPIC_API_KEY = '';
process.env.ANTHROPIC_AUTH_TOKEN = '';
process.env.GEMINI_API_KEY = '';
process.env.GOOGLE_API_KEY = '';
process.env.ADZUNA_APP_ID = '';
process.env.ADZUNA_APP_KEY = '';
process.env.USAJOBS_API_KEY = '';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { scamHeuristics, extractFacts, runRedflag, verdictFromFlags, distillResult, formatRedflagCard } = await import('../src/skills/redflag.js');

const SCAM_POSTING = {
  title: 'Data Entry Specialist',
  company: 'Global Logistics Ltd',
  description:
    'Earn $600/day working from home! No interview required — immediate start. ' +
    'A $49 application fee covers your training kit. ' +
    'Send your bank account details now to process your first paycheck. ' +
    'Contact us only via Telegram @quickhire_jobs.',
};

const CLEAN_POSTING = {
  company: 'TestCo',
  title: 'Senior Backend Engineer',
  description: 'TypeScript and Node.js role on a payments team. Remote-first, quarterly onsites. Apply at jobs@testco.example.',
  location: 'remote',
  compMin: 140000,
  compMax: 170000,
};

// ── local scam heuristics ───────────────────────────────────────────────────

test('redflag: scam heuristics catch the classic fraud patterns', async () => {
  const facts = await extractFacts(SCAM_POSTING);
  const flags = scamHeuristics(SCAM_POSTING, facts);
  const titles = flags.map((f) => f.title).join(' | ');
  assert.match(titles, /Payment demanded to apply/);
  assert.match(titles, /Chat-app-only contact/);
  assert.match(titles, /Sensitive data demanded upfront|Hired without an interview/);
  assert.ok(flags.some((f) => f.severity === 'red'), 'at least one red flag');
});

test('redflag: a clean posting raises no heuristic flags', async () => {
  const facts = await extractFacts(CLEAN_POSTING);
  const flags = scamHeuristics(CLEAN_POSTING, facts);
  assert.equal(flags.filter((f) => f.severity === 'red').length, 0);
});

test('redflag: verdict escalates with severity', () => {
  assert.equal(verdictFromFlags([{ severity: 'red' }]), 'avoid');
  assert.equal(verdictFromFlags([{ severity: 'yellow' }]), 'caution');
  assert.equal(verdictFromFlags([{ severity: 'green' }]), 'clear');
  assert.equal(verdictFromFlags([]), 'unknown');
});

// ── fact extraction ─────────────────────────────────────────────────────────

test('redflag: structured input keeps its facts, url and claims surface', async () => {
  const facts = await extractFacts({
    company: 'Acme',
    title: 'Staff Engineer',
    description: 'Remote role paying $200k. We are a Series B company. Apply at https://acme.example/careers.',
  });
  assert.equal(facts.company, 'Acme');
  assert.equal(facts.title, 'Staff Engineer');
  assert.equal(facts.url, 'https://acme.example/careers');
  assert.ok(facts.claims.length >= 1, 'salary/funding sentences become checkable claims');
});

test('redflag: free text falls back to heuristic extraction', async () => {
  const facts = await extractFacts({ text: 'Senior Backend Engineer at Acme Corp\nTypeScript role, $150k+.' });
  assert.match(facts.company ?? '', /Acme/);
  assert.ok(facts.title, 'role extracted');
});

// ── the report, without any network ─────────────────────────────────────────

test('redflag: report without telegraph is honest about skipped paid checks', async () => {
  const report = await runRedflag(SCAM_POSTING);
  assert.equal(report.verdict, 'avoid', 'hard scam patterns drive the verdict');
  assert.equal(report.spendUsd, 0, 'nothing was paid');
  assert.ok(report.flags.some((f) => f.severity === 'red'));
  const paid = report.checks.filter((c) => c.source === 'telegraph');
  assert.equal(paid.length, 4, 'all four network checks are listed');
  for (const check of paid) {
    assert.equal(check.status, 'skipped', 'skipped, not silently dropped');
    assert.match(check.summary, /not configured/i);
  }
  assert.ok(report.confidence > 0 && report.confidence <= 0.6, 'confidence stays honest without network checks');
});

test('redflag: clean posting degrades to caution/unknown rather than inventing a clear', async () => {
  const report = await runRedflag(CLEAN_POSTING);
  assert.notEqual(report.verdict, 'avoid');
  // No heuristics fired, no telegraph ran — the fallback must not claim
  // verification it never performed.
  assert.ok(report.checks.every((c) => c.source !== 'telegraph' || c.status === 'skipped'));
});

// ── injected engine: budget accounting and provenance ──────────────────────

function fakeEngine(behavior: Record<string, { ok: boolean; minerName: string; costUsd: number; result: unknown; skipped?: boolean; error?: string }>) {
  return async (opts: { query: string }) => {
    for (const [needle, resp] of Object.entries(behavior)) {
      if (opts.query.toLowerCase().includes(needle)) return { warnings: [], ...resp };
    }
    return { ok: false, skipped: true, error: 'no matching behavior' };
  };
}

test('redflag: paid checks land in flags with miner provenance and cost', async () => {
  const engine = fakeEngine({
    'layoffs, hiring freezes': {
      ok: true, minerName: 'newsminer', costUsd: 0.01,
      result: { label: 'Acme layoffs', reason: 'Acme Corp announced layoffs of 300 staff last month.', confidence: 0.9 },
    },
    'recruitment scam': {
      ok: true, minerName: 'fraudminer', costUsd: 0.01,
      result: { label: 'No scam indicators', reason: 'Posting matches legitimate hiring patterns.', confidence: 0.85 },
    },
  });
  const report = await runRedflag(
    { company: 'Acme Corp', title: 'Backend Engineer', description: 'TypeScript role at https://acme.example/careers/jobs/1' },
    { engineAsk: engine as never, budgetUsd: 0.05 },
  );
  const ok = report.checks.filter((c) => c.source === 'telegraph' && c.status === 'ok');
  assert.equal(ok.length, 2, 'fraud + news ran; urlscan/facts had subject matter');
  assert.equal(report.spendUsd, 0.02, 'spend is the sum of served check costs');
  const newsFlag = report.flags.find((f) => f.title.includes('warning'));
  assert.ok(newsFlag, 'alarming news surfaces as a flag');
  assert.match(newsFlag!.source, /telegraph:newsminer/);
  assert.equal(newsFlag!.costUsd, 0.01, 'flag carries the cost of its evidence');
});

test('redflag: a check priced over the remaining budget is skipped, not bought', async () => {
  const engine = async (opts: { query: string; maxCostUsd?: number }): Promise<{ ok: boolean; skipped?: boolean; error?: string }> => {
    // Every check "costs" more than the caller allows.
    if (opts.maxCostUsd !== undefined && opts.maxCostUsd < 0.5) {
      return { ok: false, skipped: true, error: 'priced over budget' };
    }
    return { ok: true };
  };
  const report = await runRedflag({ company: 'Acme Corp' }, { engineAsk: engine as never, budgetUsd: 0.02 });
  assert.equal(report.spendUsd, 0);
  for (const check of report.checks.filter((c) => c.source === 'telegraph')) {
    assert.equal(check.status, 'skipped');
  }
});

test('redflag: budget exhaustion mid-report stops buying but still reports', async () => {
  let calls = 0;
  const PRICE = 0.03;
  const engine = async (opts: { maxCostUsd?: number }): Promise<{ ok: boolean; skipped?: boolean; minerName: string; costUsd: number; result: unknown }> => {
    // Mirrors the real client contract: the probe declines a call priced
    // above the maxCostUsd the caller allows.
    if (opts.maxCostUsd !== undefined && PRICE > opts.maxCostUsd) {
      return { ok: false, skipped: true, minerName: '', costUsd: 0, result: null };
    }
    calls += 1;
    return { ok: true, minerName: `miner${calls}`, costUsd: PRICE, result: { label: 'x', reason: 'y', confidence: 0.5 } };
  };
  const report = await runRedflag(
    { company: 'Acme Corp', title: 'Engineer', description: 'role https://acme.example/jobs' },
    { engineAsk: engine as never, budgetUsd: 0.05 },
  );
  // First check eats $0.03; $0.02 remains — too little for another $0.03 call.
  assert.equal(calls, 1, 'only one paid call went out');
  assert.equal(report.spendUsd, 0.03);
  const skipped = report.checks.filter((c) => c.status === 'skipped');
  assert.ok(skipped.length >= 1, 'later checks are skipped with a reason');
});

// ── presentation ────────────────────────────────────────────────────────────

test('redflag: card names every check, its status and the spend', async () => {
  const report = await runRedflag(SCAM_POSTING);
  const card = formatRedflagCard(report);
  assert.match(card, /Avoid/);
  assert.match(card, /Local scam-pattern scan/);
  assert.match(card, /Miner spend: \$0\.00/);
});

test('redflag: distillResult reads signal-shaped miners and raw blobs', () => {
  const shaped = distillResult({ label: '2 matches', reason: 'scanned Adzuna', confidence: 0.8 });
  assert.equal(shaped.label, '2 matches');
  assert.match(shaped.text, /scanned Adzuna/);
  const raw = distillResult({ temperature: 21.4, wind: 3 });
  assert.match(raw.text, /temperature/);
  assert.equal(distillResult(null).text, '(miner returned no content)');
});

test('redflag: distillResult unwraps search-shaped miner results', () => {
  // Tavily shape: answer null, results[] with title+content — the top hits
  // become readable evidence instead of a raw JSON blob.
  const tavily = distillResult({
    answer: null,
    query: 'news about Datadog',
    results: [
      { title: 'Datadog announces layoffs', content: 'Datadog cut 300 roles in restructuring.' },
      { title: 'Datadog Q2 earnings', content: 'Revenue up 22% year over year.' },
    ],
  });
  assert.match(tavily.label ?? '', /2\+ sources/);
  assert.match(tavily.text, /Datadog announces layoffs/);
  assert.match(tavily.text, /Q2 earnings/);
  // A truly empty search still degrades to the raw JSON.
  assert.match(distillResult({ answer: null, results: [] }).text, /^\{/);
});

test('telegraph: direct-fallback payload lands the query in the field the miner reads', async () => {
  const { buildDirectPayload } = await import('../src/telegraph/client.js');
  // Tavily-shape: query field, alias match.
  const tavily = buildDirectPayload(
    { id: '202', slug: 'tavily', name: 'Tavily', input_schema: { properties: { query: { type: 'string' }, max_results: { type: 'integer' } } } },
    'news about Acme',
  );
  assert.deepEqual(tavily, { query: 'news about Acme' });
  // GNews-shape: q field, alias match, maxLength respected.
  const gnews = buildDirectPayload(
    { id: '210', slug: 'gnews', name: 'GNews', input_schema: { properties: { q: { type: 'string', maxLength: 5 } } } },
    'news about Acme',
  );
  assert.deepEqual(gnews, { q: 'news ' });
  // Structured-only miner: no text-shaped field → no payload, no paid call.
  const structured = buildDirectPayload(
    { id: '1', slug: 'x', name: 'X', input_schema: { properties: { lat: { type: 'number' }, lon: { type: 'number' } } } },
    'anything',
  );
  assert.equal(structured, null);
  // Constrained first field skipped in favor of a pattern-free string.
  const verity = buildDirectPayload(
    { id: '9004', slug: 'verity', name: 'Verity', input_schema: { properties: { country: { type: 'string', pattern: '^[A-Za-z]{2}$' }, query: { type: 'string' } } } },
    'layoffs at Acme',
  );
  assert.deepEqual(verity, { query: 'layoffs at Acme' });
});

// ── HTTP surface ────────────────────────────────────────────────────────────

const { startServer } = await import('../src/server.js');
const server = startServer(0);
await new Promise<void>((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
test.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

test('api: /api/redflag demands payment before vetting', async () => {
  const res = await fetch(`${base}/api/redflag`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ company: 'Acme Corp', title: 'Engineer', description: 'TypeScript role' }),
  });
  assert.equal(res.status, 402);
  const data = (await res.json()) as { payment?: { priceUsd?: string; amount?: string } };
  assert.equal(data.payment?.priceUsd, '0.05');
});

test('api: catalog lists redflag at $0.05', async () => {
  const res = await fetch(`${base}/api/services`);
  assert.equal(res.status, 200);
  const data = (await res.json()) as { services: Array<{ id: string; priceUsd: string }> };
  const redflag = data.services.find((s) => s.id === 'redflag-vetting');
  assert.ok(redflag, 'redflag in catalog');
  assert.equal(redflag!.priceUsd, '0.05');
});

test('api: /health reports the telegraph consumer side', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const data = (await res.json()) as { telegraph?: { configured: boolean; nodeUrl: string } };
  assert.equal(typeof data.telegraph?.configured, 'boolean');
  assert.ok(data.telegraph?.nodeUrl);
});

test('redflag: a comfortable budget runs the miner checks in parallel', async () => {
  // The four checks are independent lookups; running them concurrently cuts
  // the flagship "full vetting" wait from the sum of four calls to the slowest
  // single one. Each mock call sleeps 200ms — sequential would be ~800ms.
  let concurrent = 0;
  let peak = 0;
  const engine = async (opts: { maxCostUsd?: number }): Promise<{ ok: boolean; minerName: string; costUsd: number; result: unknown }> => {
    concurrent += 1;
    peak = Math.max(peak, concurrent);
    await new Promise((r) => setTimeout(r, 200));
    concurrent -= 1;
    return { ok: true, minerName: 'm', costUsd: opts.maxCostUsd ?? 0.01, result: { label: 'ok', reason: 'fine' } };
  };
  const report = await runRedflag(
    { company: 'Acme Corp', title: 'Engineer', description: 'Great role. https://acme.example/jobs Salary $200k guaranteed.' },
    { engineAsk: engine as never, budgetUsd: 0.08 },
  );
  // Peak concurrency is the direct evidence of parallelism; wall-clock is not,
  // because runRedflag also runs a comp-benchmark scan and synthesis around
  // the checks. Sequential execution would never let peak exceed 1.
  assert.ok(peak >= 2, `checks must overlap, peak concurrency was ${peak}`);
  // Even if every miner charged its full per-check share, the total is capped.
  assert.ok(report.spendUsd <= 0.08 + 1e-9, `spend ${report.spendUsd} must never exceed the $0.08 budget`);
});

test('redflag: the parallel path never exceeds budget even if every miner charges its cap', async () => {
  // Each miner charges exactly the maxCostUsd it is handed — the worst case
  // for a fixed budget. The equal-share cap must still keep the total ≤ budget.
  const engine = async (opts: { maxCostUsd?: number }): Promise<{ ok: boolean; minerName: string; costUsd: number; result: unknown }> =>
    ({ ok: true, minerName: 'greedy', costUsd: opts.maxCostUsd ?? 0.02, result: { label: 'ok', reason: 'x' } });
  const report = await runRedflag(
    { company: 'Acme Corp', title: 'Engineer', description: 'Role. https://acme.example/jobs Claims: remote, $300k, equity.' },
    { engineAsk: engine as never, budgetUsd: 0.08 },
  );
  assert.ok(report.spendUsd <= 0.08 + 1e-9, `spend ${report.spendUsd} exceeded budget`);
  assert.ok(report.spendUsd > 0, 'checks actually ran and were paid for');
});
