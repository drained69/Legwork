#!/usr/bin/env node
/**
 * Stand-in for the `onchainos` CLI.
 *
 * Behaviour is driven by the JSON control file at $FAKE_CLI_STATE, re-read on
 * every invocation so a test can change the world between calls. Every call is
 * appended to `state.calls` so tests can assert on what was — and was not — run.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const statePath = process.env.FAKE_CLI_STATE;
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);

state.calls.push(['onchainos', ...args].join(' '));
writeFileSync(statePath, JSON.stringify(state, null, 2));

const cmd = args[1]; // args[0] is always `agent`

if (args[0] === '--version') {
  console.log('onchainos 4.3.0-fake');
} else if (cmd === 'deliver') {
  if (state.deliverFails) {
    console.log(JSON.stringify({ ok: false, error: 'status != accepted' }));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, data: { txHash: '0xdeadbeef' } }));
} else if (cmd === 'task-deliverable-list') {
  // Real CLI shape: a --job-id query returns `deliverables`, not `results`.
  const deliverables = state.retrievable ? [{ jobId: args[3], deliverableType: 'file' }] : [];
  console.log(JSON.stringify({ ok: true, data: { deliverables } }));
} else {
  console.log(JSON.stringify({ ok: true, data: {} }));
}
