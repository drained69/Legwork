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
} else if (args[0] === 'xmtp-send') {
  state.sentMessages.push(args[args.indexOf('--message') + 1]);
  console.log(JSON.stringify({ ok: true }));
}

writeFileSync(statePath, JSON.stringify(state, null, 2));
