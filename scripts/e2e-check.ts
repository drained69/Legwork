/**
 * FULL local end-to-end check — every route, real externals (live job boards,
 * Gemini, CoinGecko, real Telegraph engine with real USDC spend).
 *
 * Spends real testnet USDC (~$0.10-0.20): one full web vetting + one for the
 * rate-limit probe. Usage: npx tsx scripts/e2e-check.ts
 */
import 'dotenv/config';
process.env.TELEGRAPH_PRIVATE_KEY ||= process.env.EVM_PRIVATE_KEY ?? '';
process.env.DATABASE_PATH = '/tmp/legwork-e2e.db';
process.env.PORT = '0';
// Tight rate limit so the 429 probe costs ONE vetting, not two.
process.env.REDFLAG_WEB_FULL_RATE_PER_HOUR = '1';

import { rmSync } from 'node:fs';
import { createHash } from 'node:crypto';

rmSync(process.env.DATABASE_PATH!, { force: true });
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
const client = (name: string): Record<string, string> => ({ 'x-internal-client': `e2e:${name}` });
const post = async (path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; data: any }> => {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

console.log(`e2e — server on :${(server.address() as { port: number }).port}`);
console.log(`  llm: ${config.llm.enabled || config.gemini.enabled ? 'live' : 'KEYLESS'} · telegraph wallet: ${config.telegraph.enabled ? 'configured' : 'MISSING'} · adzuna: ${config.adzuna.enabled}\n`);

// ── 1. health & identity ────────────────────────────────────────────────────
const health = await (await fetch(`${base}/health`)).json();
ok('GET /health', health.ok === true);
ok('  llm live', health.llm?.configured === true && health.llm?.provider, String(health.llm?.provider));
ok('  telegraph configured', health.telegraph?.configured === true);
ok('  live sources', health.sources?.adzuna === true && health.sources?.usajobs === true);

const services = await (await fetch(`${base}/api/services`)).json();
ok('GET /api/services catalog', Array.isArray(services.services) && services.services.length >= 4, `${services.services?.length} services`);

// ── 2. miner surface (what validators score) ────────────────────────────────
const yaml = await (await fetch(`${base}/miner.yaml`)).text();
const yamlHash = createHash('sha256').update(yaml).digest('hex');
ok('GET /miner.yaml serves the on-chain-committed bytes', yamlHash === '09190216708c49b2af81aef7ae879fceddffd70aca03f69c49ac5aabb7195138', `0x${yamlHash.slice(0, 12)}…`);

const hunt = await post('/miner/job-hunt', { query: 'senior backend engineer, TypeScript, remote, $150k+' });
ok('miner job-hunt: live shortlist', hunt.status === 200 && hunt.data.matches?.length >= 1, `${hunt.data.matches?.length} matches, conf ${hunt.data.confidence}`);
ok('  every match scoreable', hunt.data.matches?.every((m: any) => typeof m.score === 'number' && m.title && m.company && m.url));

const price = await post('/miner/job-hunt', { query: 'What is the current price of Bitcoin (BTC) in US dollars as of September 2, 2026?' });
ok('miner job-hunt: dated price from LIVE market data', price.status === 200 && /Bitcoin price on September 2, 2026: \$[\d,]+/.test(price.data.label), price.data.label);

const priceNow = await post('/miner/job-hunt', { query: 'What is the current price of Ethereum in US dollars?' });
ok('miner job-hunt: current price live', priceNow.status === 200 && /Ethereum price: \$[\d,]+/.test(priceNow.data.label), priceNow.data.label);

const sfJob = await post('/miner/job-hunt', { query: 'Find a mid-level backend engineer role in San Francisco with a minimum annual salary of $150,000, prioritizing positions that offer remote work flexibility' });
ok('miner job-hunt: salary-floor FIND-A-JOB returns the shortlist (bug fix)', sfJob.status === 200 && sfJob.data.matches?.length >= 1 && !/Not enough advertised salaries/.test(sfJob.data.label), `${sfJob.data.matches?.length} matches`);

const pay = await post('/miner/job-hunt', { query: 'what does a data analyst earn in New York' });
ok('miner job-hunt: pay question synthesises a number', pay.status === 200 && /median \$[\d,]+k/.test(pay.data.label), pay.data.label);

const general = await post('/miner/job-hunt', { query: 'What role does the Federal Reserve play in inflation?' });
ok('miner job-hunt: general question answered directly', general.status === 200 && general.data.confidence >= 0.5 && !/Not a job-search query/.test(general.data.label), general.data.label.slice(0, 80));

const tailor = await post('/miner/tailor', { prompt: 'write a cover letter for a senior backend engineer position at Acme Corp' });
ok('miner tailor: label CARRIES the document', tailor.status === 200 && /Dear/.test(tailor.data.label), tailor.data.label.slice(0, 80));

const emptyTailor = await post('/miner/tailor', {});
ok('miner tailor: empty body never fails', emptyTailor.status === 200 && emptyTailor.data.confidence > 0);

const alias = await post('/miner/job-hunt', { q: 'backend engineer jobs, remote' });
ok('miner job-hunt: q alias accepted', alias.status === 200 && Array.isArray(alias.data.matches));

// ── 3. the free surfaces ────────────────────────────────────────────────────
const page = await fetch(`${base}/redflag`);
const pageHtml = await page.text();
ok('GET /redflag serves the app', page.status === 200 && pageHtml.includes('Run verification') && pageHtml.includes('/api/stats'));

const huntPreview = await post('/api/hunt/preview', { roles: ['backend engineer'], locations: ['remote'] }, client('preview'));
ok('POST /api/hunt/preview (free, live)', huntPreview.status === 200 && huntPreview.data.ok === true, `${huntPreview.data.totalMatches} matches`);

const freeScan = await post('/api/redflag/preview', { text: 'Senior Backend Engineer at Shopify\nRemote-first, $170k–$210k. Apply at https://jobs.shopify.com/careers' }, client('free'));
ok('POST /api/redflag/preview (free scan)', freeScan.status === 200 && freeScan.data.ok === true, `verdict ${freeScan.data.verdict}`);
ok('  free scan spends $0', freeScan.data.result.spendUsd === 0);

// ── 4. the FULL web vetting (real engine, real USDC) ────────────────────────
console.log('\n── full web vetting (real miner spend) ──');
const full = await post('/api/redflag/web', { text: 'Senior Backend Engineer at Stripe\nRemote, $180k–$220k. TypeScript payments team. Apply at https://stripe.com/jobs/search' }, client('full'));
const telegraphChecks = full.data.report?.checks?.filter((c: any) => c.source === 'telegraph') ?? [];
const liveOnes = telegraphChecks.filter((c: any) => c.status === 'ok' || c.status === 'cached');
ok('POST /api/redflag/web buys live miner answers', full.status === 200 && full.data.ok === true && liveOnes.length >= 2, `${liveOnes.length}/4 checks ran`);
ok('  share URL issued', typeof full.data.shareUrl === 'string' && /\/report\//.test(full.data.shareUrl));
ok('  spend reported', full.data.report.spendUsd > 0, `$${full.data.report.spendUsd?.toFixed(2)} of $${full.data.report.budgetUsd?.toFixed(2)}`);
for (const c of telegraphChecks) console.log(`    ${c.status.padEnd(7)} ${c.label}${c.miner ? ` · ${c.miner}` : ''}${c.costUsd ? ` ($${c.costUsd.toFixed(2)})` : ''}`);

// ── 5. the report surfaces ──────────────────────────────────────────────────
const reportId = String(full.data.shareUrl).split('/report/')[1];
const reportPage = await fetch(`${base}/report/${reportId}`);
const reportHtml = await reportPage.text();
ok('GET /report/:id renders the receipt', reportPage.status === 200 && reportHtml.includes('Stripe'));
const someMiner = liveOnes[0]?.miner;
ok('  receipt names the serving miner', !someMiner || reportHtml.includes(someMiner), String(someMiner));

const reportJson = await (await fetch(`${base}/api/report/${reportId}`)).json();
ok('GET /api/report/:id JSON', reportJson.ok === true && reportJson.report.company === full.data.report.company);

const noReport = await fetch(`${base}/report/not-a-uuid`);
ok('GET /report/<bad> 404s', noReport.status === 404);

// ── 6. stats reflect the ledger ─────────────────────────────────────────────
const stats = await (await fetch(`${base}/api/stats`)).json();
ok('GET /api/stats counts the bought checks', stats.ok === true && stats.checksBought >= liveOnes.length && stats.minerSpendUsd >= full.data.report.spendUsd, `${stats.checksBought} checks · $${stats.minerSpendUsd.toFixed(2)} paid · ${stats.distinctMinersUsed} miners`);
ok('  recent-verdicts feed lists the vetting', Array.isArray(stats.recent) && stats.recent.some((r: any) => r.id === reportId));

// ── 7. guardrails ───────────────────────────────────────────────────────────
const paid = await post('/api/redflag', { company: 'Acme Corp' });
ok('POST /api/redflag demands payment (402)', paid.status === 402 && paid.data.payment?.priceUsd === '0.05');

// Rate limit: this client's first call spends, the second must 429 (limit 1/hour).
const rlFirst = await post('/api/redflag/web', { text: 'Product Manager at Figma\nHybrid SF, $160k–$200k.' }, client('ratelimit'));
const rlSecond = await post('/api/redflag/web', { text: 'Product Manager at Figma\nHybrid SF, $160k–$200k.' }, client('ratelimit'));
ok('web vetting rate limit trips', rlFirst.status === 200 && rlSecond.status === 429, `first ${rlFirst.status}, second ${rlSecond.status}: ${rlSecond.data.error?.slice(0, 60)}`);

// Daily budget: seed the ledger at the ceiling for today, fresh client → refusal.
const todayStart = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').toISOString();
saveRedflagReport({ id: 'e2e-budget-seed', userId: 'web:e2e-budget', company: 'CapEater', verdict: 'clear', spendUsd: Number(process.env.REDFLAG_WEB_DAILY_BUDGET_USD ?? '3') - 0.001, at: todayStart, data: { checks: [] } });
const budget = await post('/api/redflag/web', { text: 'Engineer at BudgetTestCo, remote' }, client('budget'));
ok('daily budget ceiling enforced from the ledger', budget.status === 429 && /budget/i.test(budget.data.error), budget.data.error?.slice(0, 70));

const notFound = await fetch(`${base}/nope`);
ok('unknown route still 404s (miners claimed correctly)', notFound.status === 404);

// ── summary ─────────────────────────────────────────────────────────────────
console.log('');
await new Promise<void>((resolve) => server.close(() => resolve()));
if (fails.length) {
  console.error(`\n${fails.length} E2E FAILURE(S):\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
console.log('ALL LOCAL E2E CHECKS PASSED');
process.exit(0);
