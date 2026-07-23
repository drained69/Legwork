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
} else if (args[0] === 'session' && args[1] === 'history') {
  // Real shape: rows whose `content` is a JSON-encoded envelope; the text is
  // at .content inside it and the author at .sender.agentId.
  const rows = (state.chatHistory ?? []).map((m, i) => ({
    id: `msg-${i}`,
    senderInboxId: `inbox-${m.fromAgentId}`,
    content: JSON.stringify({ msgType: 'a2a-agent-chat', content: m.content, sender: { agentId: m.fromAgentId } }),
    sentAt: m.sentAt,
    deliveryStatus: 'published',
  }));
  console.log(JSON.stringify(rows));
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
    // Verified live: `session send` is AI DISPATCH, not outbound messaging —
    // in a container with no AI CLI it always fails this way.
    console.log(JSON.stringify({ ok: false, error: 'No supported AI CLI found. Install one of: codex, claude, hermes, openclaw.' }));
    process.exitCode = 1;
  }
} else if (args[0] === 'xmtp-send') {
  // Faithful to the daemon: the CLI queues and reports ok REGARDLESS, but the
  // message only actually leaves when a session exists for the job. A test
  // that asserts on sentMessages therefore proves the session precondition —
  // this exact gap hid a 100% send-failure rate behind ok responses.
  const jobId = args[args.indexOf('--job-id') + 1];
  if ((state.sessions ?? []).includes(jobId)) {
    state.sentMessages.push(args[args.indexOf('--message') + 1]);
  }
  console.log(JSON.stringify({ ok: true }));
}

writeFileSync(statePath, JSON.stringify(state, null, 2));
