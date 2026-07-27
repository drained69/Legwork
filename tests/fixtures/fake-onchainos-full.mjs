#!/usr/bin/env node
/**
 * Faithful stand-in for `onchainos` covering the whole ASP task lifecycle.
 *
 * Mirrors the REAL CLI's contracts as observed against the live tool:
 *   - active-tasks returns JSON with NO description field (title + budget only)
 *   - agent status likewise carries no description
 *   - deliver exits 0 even when the payload leg fails
 * Every invocation is appended to the control file so a test can assert on the
 * exact argv the poller built.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const statePath = process.env.FAKE_CLI_STATE;
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
state.calls.push(['onchainos', ...args].join(' '));

const out = (o) => console.log(JSON.stringify(o));
const cmd = args[1]; // args[0] === 'agent'

if (args[0] === '--version') {
  console.log('onchainos 4.3.0-fake');
} else if (cmd === 'gate-check') {
  // Mirrors production: communication false because the doctor fails on
  // provider_binding, while XMTP itself is perfectly healthy.
  out({ ok: true, data: { ready: false, wallet: { ok: true }, identity: { ok: true, agentId: '6658' }, communication: { ok: false } } });
} else if (cmd === 'active-tasks') {
  out({ ok: true, data: { tasks: state.tasks } });
} else if (cmd === 'heartbeat') {
  out({ ok: true, data: {} });
} else if (cmd === 'contact-user') {
  // Real failure mode: contact-user bundles session-create with the opener,
  // and its session-create leg fails on installs expecting an AI gateway.
  if (state.contactFails) {
    out({ ok: false, error: 'session create failed: connect ECONNREFUSED 127.0.0.1:18789' });
    process.exitCode = 1;
    writeFileSync(statePath, JSON.stringify(state, null, 2));
    process.exit(1);
  }
  out({ ok: true, data: {} });
} else if (cmd === 'apply') {
  out({ ok: true, data: { txHash: '0xapply' } });
} else if (cmd === 'deliver') {
  const fileIdx = args.indexOf('--file');
  state.deliveredFile = fileIdx > -1 ? args[fileIdx + 1] : null;
  state.retrievable = true; // payload leg succeeded
  out({ ok: true, data: { txHash: '0xdeliver' } });
} else if (cmd === 'task-deliverable-list') {
  // Real CLI shape: a --job-id query returns `deliverables`, not `results`.
  out({ ok: true, data: { deliverables: state.retrievable ? [{ jobId: args[3], deliverableType: 'file' }] : [] } });
} else if (cmd === 'recommend-task') {
  out({ ok: false, error: 'not needed for this test' });
} else {
  out({ ok: true, data: {} });
}
writeFileSync(statePath, JSON.stringify(state, null, 2));
