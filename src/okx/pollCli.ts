import { config } from '../config.js';
import { activeTasks, cliAvailable, gateCheck } from './marketplace.js';
import { pollOnce } from './poller.js';

/**
 * One-shot marketplace poll — `npm run okx:poll`.
 *
 * Prints readiness and the current task list, then runs exactly one cycle.
 * Defaults to DRY RUN: it reports what a live tick would claim and touches
 * nothing. Pass `--live` to actually claim.
 *
 *   npm run okx:poll           # inspect only
 *   npm run okx:poll -- --live # claim for real
 */
async function main(): Promise<void> {
  const live = process.argv.includes('--live');
  if (!live) process.env.OKX_POLL_DRY_RUN = 'true';
  // config is read at import time; keep the flag honest for this process.
  (config.okx as { dryRun: boolean }).dryRun = !live;

  console.log(`OKX marketplace poll — ${live ? 'LIVE (will claim tasks)' : 'DRY RUN (no on-chain action)'}`);
  console.log(`  agent: ${config.okx.aspAgentId || '(OKX_ASP_AGENT_ID not set!)'}`);

  if (!(await cliAvailable())) {
    console.error('  onchainos CLI not found on PATH — nothing can be claimed from this host.');
    process.exit(1);
  }

  const gate = await gateCheck();
  console.log(`  gate-check: ready=${gate.ready} wallet=${gate.wallet} identity=${gate.identity} comms=${gate.communication}` +
    `${gate.agentId ? ` signed-in-agent=${gate.agentId}` : ''}${gate.error ? ` error=${gate.error}` : ''}`);
  if (!gate.ready) process.exit(1);

  const { ok, tasks, error } = await activeTasks();
  if (!ok) {
    console.error(`  active-tasks failed: ${error}`);
    process.exit(1);
  }
  console.log(`\n  ${tasks.length} task(s) routed to this agent:`);
  for (const t of tasks) {
    console.log(`    [${t.status ?? t.statusCode}] ${t.jobId} — ${t.tokenAmount ?? '?'} ${t.tokenSymbol ?? ''} — "${t.title}"`);
  }
  const unclaimed = tasks.filter((t) => t.statusCode === 0).length;
  if (unclaimed) console.log(`\n  ⚠ ${unclaimed} task(s) still in "created" — these expire if the agent never claims them.\n`);

  await pollOnce({ bot: null });
  console.log(live ? '\nDone — claims submitted.' : '\nDone — dry run, nothing was claimed. Re-run with --live to act.');
  process.exit(0);
}

main().catch((err) => {
  console.error('poll failed:', err);
  process.exit(1);
});
