/**
 * Live smoke test for Redflag — makes REAL paid engine calls through the
 * Telegraph devnode (~$0.01 per check, up to REDFLAG_MAX_SPEND_USD).
 *
 * Usage:
 *   npx tsx scripts/redflag-smoke.ts                     # demo posting
 *   npx tsx scripts/redflag-smoke.ts "Senior Engineer at Stripe, remote, $200k" COMPANY_URL
 *
 * Requires TELEGRAPH_PRIVATE_KEY (or EVM_PRIVATE_KEY) funded with Base
 * Sepolia USDC. Never part of `npm test`.
 */
import 'dotenv/config';

process.env.TELEGRAPH_PRIVATE_KEY ||= process.env.EVM_PRIVATE_KEY ?? '';

const { runRedflag, formatRedflagCard } = await import('../src/skills/redflag.js');

const posting = process.argv[2]
  ?? 'Senior Backend Engineer at Shopify\nRemote-first, $170k–$210k. Apply at https://jobs.shopify.com/careers/senior-backend-engineer';

const input = process.argv[3]
  ? { text: posting, url: process.argv[3] }
  : { text: posting };

console.log('Redflag live smoke — posting:');
console.log(posting, '\n');

const report = await runRedflag(input);
console.log(formatRedflagCard(report), '\n');
console.log('── per-check provenance ──');
for (const check of report.checks) {
  const miner = check.miner ? ` · miner ${check.miner}` : '';
  const hash = check.signalHash ? ` · signal ${check.signalHash.slice(0, 18)}…` : '';
  console.log(`${check.status.padEnd(8)} ${check.label} (${check.source}${miner})${hash}${check.costUsd ? ` — $${check.costUsd.toFixed(2)}` : ''}`);
  if (check.summary) console.log(`           ${check.summary.slice(0, 160)}`);
}
console.log(`\nverdict=${report.verdict} confidence=${report.confidence} spend=$${report.spendUsd.toFixed(2)}/${report.budgetUsd.toFixed(2)}`);
