/**
 * Debug: call OUR OWN miner (8402) through the engine exactly as validators'
 * traffic flows, then fetch the stored signal — what the scorer actually sees.
 *
 * Usage: npx tsx scripts/self-probe.ts [intent-probe]
 */
import 'dotenv/config';
process.env.TELEGRAPH_PRIVATE_KEY ||= process.env.EVM_PRIVATE_KEY ?? '';

const { engineAsk, telegraphNodeUrl } = await import('../src/track3/telegraph.js');

const probes = {
  websearch: { query: 'remote software engineering jobs paying over 150k', intent: 'WEB_SEARCH' },
  research: { query: 'what does a data analyst earn in New York', intent: 'RESEARCH_SYNTHESIS' },
  textgen: { query: 'write a cover letter for a senior backend engineer position at Acme Corp', intent: 'TEXT_GENERATION' },
};

const which = (process.argv[2] ?? 'websearch') as keyof typeof probes;
const probe = probes[which] ?? probes.websearch;

console.log(`── engine auto-routed ask (${which}) ──`);
console.log(JSON.stringify(probe), '\n');
const res = await engineAsk({ ...probe, noCache: true, timeoutMs: 45_000 });
console.log('ok:', res.ok, '| miner:', res.minerId, res.minerName, '| intent:', res.intent);
console.log('cost:', res.costUsd, '| duration_ms:', res.durationMs, '| signal:', res.signalHash);
if (res.error) console.log('error:', res.error);
if (res.result) console.log('\nresult (first 900 chars):', JSON.stringify(res.result, null, 2).slice(0, 900));

if (res.signalHash) {
  const sigRes = await fetch(`${telegraphNodeUrl()}/engine/v1/signal/${res.signalHash}`);
  const sig = (await sigRes.json()) as Record<string, unknown>;
  console.log('\n── stored signal ──');
  console.log(JSON.stringify(sig, null, 2).slice(0, 1200));
}
