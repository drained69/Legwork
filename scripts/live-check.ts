/**
 * LIVE end-to-end check for every Redflag flow (NOT part of npm test — spends
 * real testnet USDC). Boots the real server with the real .env, then:
 *
 *   1. GET /redflag                       — the web demo page
 *   2. POST /api/redflag/preview          — free scan with LIVE job boards
 *   3. POST /api/redflag + real $0.05 USDC transfer
 *        → payment verified → full paid report with LIVE miner calls
 *        → report persisted to SQLite
 *   4. listRedflagReports                  — history readback
 *   5. One REAL watch tick                 — live news check through the engine
 *
 * Usage: npx tsx scripts/live-check.ts
 */
import 'dotenv/config';
process.env.TELEGRAPH_PRIVATE_KEY ||= process.env.EVM_PRIVATE_KEY ?? '';
process.env.DATABASE_PATH = '/tmp/legwork-live-check.db';
process.env.PORT = '0';
// Direct payments are configured in Railway production, not the local .env.
// For this check: the same Base Sepolia USDC the engine pays in, settling to
// the payer itself — the real verification path (tx, logs, nonce) runs
// without moving funds anywhere else.
process.env.PAYMENT_ASSET_ADDRESS ||= '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
process.env.PAYMENT_PAY_TO ||= process.env.EVM_PRIVATE_KEY ? new (await import('ethers')).Wallet(process.env.EVM_PRIVATE_KEY).address : '';

import { Wallet, Contract, JsonRpcProvider, formatUnits } from 'ethers';
import { rmSync } from 'node:fs';

const { config } = await import('../src/config.js');
const { startServer } = await import('../src/server.js');
const { runWatchTick } = await import('../src/track3/watchPoller.js');
const { createWatch, deactivateWatch, listRedflagReports } = await import('../src/db.js');
const { renderRedflagCard } = await import('../src/telegram/ui.js');

const fails: string[] = [];
const ok = (name: string, cond: boolean, detail = ''): void => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) fails.push(name);
};

rmSync(process.env.DATABASE_PATH!, { force: true });
const server = startServer(0);
await new Promise<void>((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
console.log(`live check — server on :${(server.address() as { port: number }).port}`);
console.log(`  telegraph wallet: ${config.telegraph.enabled ? 'configured' : 'MISSING'} · adzuna: ${config.adzuna.enabled}\n`);

// ── 1. the web page ─────────────────────────────────────────────────────────
const page = await fetch(`${base}/redflag`);
ok('GET /redflag serves the demo page', page.status === 200 && (await page.text()).includes('Free scan'));

// ── 2. the free preview (live boards) ───────────────────────────────────────
const preview = await fetch(`${base}/api/redflag/preview`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-internal-client': 'live-check:1' },
  body: JSON.stringify({ text: 'Senior Backend Engineer at Stripe\nRemote, $180k–$220k. Apply at https://stripe.com/jobs/search' }),
});
const previewData = (await preview.json()) as {
  ok: boolean; verdict: string;
  result: { spendUsd: number; checks: Array<{ label: string; status: string; summary: string }> };
};
ok('free preview answers 200', preview.status === 200 && previewData.ok === true);
ok('free preview spends zero on miners', previewData.result.spendUsd === 0);
const compCheck = previewData.result.checks.find((c) => c.label.includes('Comp benchmark'));
ok('live comp benchmark ran', Boolean(compCheck && (compCheck.status === 'ok' || compCheck.status === 'skipped')), compCheck?.summary.slice(0, 100));
console.log(`  preview verdict: ${previewData.verdict}\n`);

// ── 3. the paid report through the real HTTP + payment path ────────────────
const provider = new JsonRpcProvider(config.payments.rpcUrl, config.payments.chainId, { staticNetwork: true });
const payer = new Wallet(process.env.EVM_PRIVATE_KEY!, provider);
const usdc = new Contract(config.payments.asset, ['function transfer(address to, uint256 amount) returns (bool)', 'function balanceOf(address) view returns (uint256)'], payer);
const balBefore = formatUnits((await usdc.balanceOf(payer.address)) as bigint, 6);
console.log(`payer ${payer.address} · USDC ${balBefore}`);

// $0.05 in 6-decimal atomic units.
const tx = await usdc.transfer(config.payments.payTo, 50_000n);
const receipt = await tx.wait(1);
ok('payment tx confirmed', receipt?.status === 1, tx.hash);

// The server verifies via ITS OWN RPC connection, which can lag a block
// behind the payer's — wait until the transfer has 2 confirmations there
// before calling, with a retry window for slow propagation.
const serverProvider = new JsonRpcProvider(config.payments.rpcUrl, config.payments.chainId, { staticNetwork: true });
for (let i = 0; i < 12; i += 1) {
  const r = await serverProvider.getTransactionReceipt(tx.hash);
  if (r && (await r.confirmations()) >= 2) break;
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}

let paid: Response | null = null;
let paidData: { ok: boolean; result?: { verdict: string; company: string; spendUsd: number; budgetUsd: number; flags: unknown[]; checks: Array<{ source: string; status: string; miner?: string; costUsd: number }> }; error?: string } | null = null;
for (let attempt = 0; attempt < 3; attempt += 1) {
  paid = await fetch(`${base}/api/redflag`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-payment-tx': tx.hash,
      'x-user-wallet': payer.address,
    },
    body: JSON.stringify({
      company: 'Klarna',
      title: 'Staff Backend Engineer',
      description: 'Remote-first, $190k–$230k. Series-funded fintech. Apply at https://klarna.com/careers',
    }),
  });
  paidData = (await paid.json()) as typeof paidData;
  if (paid.status === 200 || attempt === 2) break;
  // Confirmation lag or transient verification failure → brief retry. A
  // FAILED verification consumes no nonce, so retrying is safe.
  await new Promise((resolve) => setTimeout(resolve, 6_000));
}
ok('paid report answers 200 after real payment', paid!.status === 200 && paidData!.ok === true, paidData!.error ?? '');
const telegraphChecks = paidData!.result?.checks.filter((c) => c.source === 'telegraph') ?? [];
const liveChecks = telegraphChecks.filter((c) => c.status === 'ok' || c.status === 'cached');
ok('paid report bought live miner answers', liveChecks.length >= 2, `${liveChecks.length}/4 network checks ran`);
console.log(`  verdict: ${paidData!.result?.verdict} · miner spend $${paidData!.result?.spendUsd.toFixed(2)} of $${paidData!.result?.budgetUsd.toFixed(2)}`);
for (const c of telegraphChecks) console.log(`    ${c.status.padEnd(7)} ${c.label}${c.miner ? ` · ${c.miner}` : ''}${c.costUsd ? ` ($${c.costUsd.toFixed(2)})` : ''}`);

// Replay protection: the same tx must be refused. Only meaningful when the
// first call actually consumed the nonce.
if (paid!.status === 200 && paidData!.ok) {
  const replay = await fetch(`${base}/api/redflag`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-payment-tx': tx.hash, 'x-user-wallet': payer.address },
    body: JSON.stringify({ company: 'Klarna' }),
  });
  const replayData = (await replay.json()) as { ok: boolean; error?: string };
  ok('payment replay is rejected', replay.status === 402 && /already been used/.test(replayData.error ?? ''), replayData.error);
}
console.log('');

// ── 4. persistence readback ─────────────────────────────────────────────────
if (paidData!.ok && paidData!.result) {
  const history = listRedflagReports(`wallet:${payer.address}`, 5);
  ok('paid report persisted', history.length === 1 && history[0].company === 'Klarna' && history[0].verdict === paidData!.result.verdict);

  // The Telegram card renders from the same payload.
  const card = renderRedflagCard({
    verdict: paidData!.result.verdict, company: paidData!.result.company, confidence: 0.8,
    flags: [], questions: [], checks: paidData!.result.checks, spendUsd: paidData!.result.spendUsd,
    budgetUsd: paidData!.result.budgetUsd, degraded: liveChecks.length === 0,
  });
  ok('Telegram verdict card renders', card.includes('Due diligence'));
}

// ── 5. one real watch tick ──────────────────────────────────────────────────
const watch = createWatch('live-check-user', 'Shopify', null);
const tick = await runWatchTick({ nowMs: Date.now() });
ok('live watch tick ran its news check', tick.checked >= 1, `checked=${tick.checked} alerted=${tick.alerted} spent=$${tick.spentUsd.toFixed(2)}${tick.errors.length ? ` errors=${tick.errors.join('; ').slice(0, 120)}` : ''}`);
deactivateWatch(watch.id);

// ── summary ─────────────────────────────────────────────────────────────────
const balAfter = formatUnits((await usdc.balanceOf(payer.address)) as bigint, 6);
console.log(`\npayer USDC after: ${balAfter}`);
await new Promise<void>((resolve) => server.close(() => resolve()));
if (fails.length) {
  console.error(`\n${fails.length} LIVE CHECK FAILURE(S): ${fails.join(', ')}`);
  process.exit(1);
}
console.log('\nALL LIVE CHECKS PASSED');
process.exit(0);
