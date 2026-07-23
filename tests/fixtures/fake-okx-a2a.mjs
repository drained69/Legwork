#!/usr/bin/env node
/** Stand-in for the `okx-a2a` XMTP side-car. Same control-file contract. */
import { readFileSync, writeFileSync } from 'node:fs';

const statePath = process.env.FAKE_CLI_STATE;
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);

state.calls.push(['okx-a2a', ...args].join(' '));

if (args[0] === 'status') {
  if (state.daemonUp) console.log('running pid=4242');
  else {
    writeFileSync(statePath, JSON.stringify(state, null, 2));
    console.error('not running');
    process.exit(1);
  }
} else if (args[0] === 'daemon' && args[1] === 'start') {
  // A restart only helps when the test says the daemon is recoverable.
  if (state.daemonRecovers) state.daemonUp = true;
  console.log('ok');
} else if (args[0] === 'session') {
  const sub = args[1];
  const jobId = args[args.indexOf('--job-id') + 1];
  state.sessions = state.sessions ?? [];
  if (sub === 'find' || sub === 'query') {
    // Mirrors the real CLI: no session => no sessionKey in the payload, which
    // is precisely the state in which every outbound send silently dies.
    const has = state.sessions.includes(jobId);
    console.log(JSON.stringify(has ? { ok: true, sessionKey: `job:${jobId}:my:6658:to:9001` } : { ok: true, sessions: [] }));
  } else if (sub === 'create') {
    if (!state.sessionCreateFails) state.sessions.push(jobId);
    console.log(JSON.stringify(state.sessionCreateFails
      ? { ok: false, error: 'session create refused' }
      : { ok: true, session: { sessionKey: `job:${jobId}:my:6658:to:9001` } }));
    if (state.sessionCreateFails) process.exitCode = 1;
  } else if (sub === 'send') {
    // A send without a session is rejected, exactly as the daemon rejects it.
    if (!state.sessions.includes(jobId)) {
      console.log(JSON.stringify({ ok: false, error: 'Cannot infer local XMTP address; create a session for this job and toAgentId first' }));
      process.exitCode = 1;
    } else {
      state.sentMessages.push(args[args.indexOf('--content') + 1]);
      console.log(JSON.stringify({ ok: true }));
    }
  }
} else if (args[0] === 'xmtp-send') {
  // The real CLI QUEUES this and returns ok before the daemon has tried, so a
  // send with no session reports success and then dies. Model that faithfully.
  state.sentMessages.push(args[args.indexOf('--message') + 1]);
  console.log(JSON.stringify({ ok: true }));
}

writeFileSync(statePath, JSON.stringify(state, null, 2));
