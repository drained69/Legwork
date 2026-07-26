/**
 * Deliverable transmission tests.
 *
 * These pin the failure that shipped an empty task to a buyer: the ASP moved a
 * task to on-chain `submitted` while the payload never reached the buyer, who
 * polled `task-deliverable-list` until the deadline, found nothing, and
 * rejected. Escrow was never funded.
 *
 * The real CLIs are replaced by fixtures driven from a JSON control file, so
 * the actual delivery code runs end to end — including the argv it builds and
 * the order it does things in.
 */
process.env.DATABASE_PATH = ':memory:';
process.env.ANTHROPIC_API_KEY = '';
process.env.OKX_BROADCAST_POLL_MS = '10';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workDir = mkdtempSync(join(tmpdir(), 'legwork-delivery-'));
const statePath = join(workDir, 'state.json');
const fixtures = new URL('./fixtures/', import.meta.url).pathname;

process.env.FAKE_CLI_STATE = statePath;
process.env.ONCHAINOS_BIN = join(fixtures, 'fake-onchainos.mjs');
process.env.OKX_A2A_BIN = join(fixtures, 'fake-okx-a2a.mjs');
process.env.OKX_ASP_AGENT_ID = '6658';
process.env.DATA_DIR = workDir;
process.env.OKX_ONCHAINOS_HOME = '';

const { saveEngagement, getEngagementById } = await import('../src/db.js');
const { submitDeliverable, repairDeliverable } = await import('../src/okx/delivery.js');
const { textDeliverIntent, fileDeliverIntent, uploadFileDeliverable, a2aDeliveryMessageBroadcast } = await import('../src/okx/marketplace.js');
const { uid } = await import('../src/db.js');
const type = await import('../src/types.js');

interface FakeState {
  calls: string[];
  sentMessages: string[];
  daemonUp: boolean;
  daemonRecovers: boolean;
  retrievable: boolean;
  deliverFails: boolean;
}

function setState(overrides: Partial<FakeState>): void {
  const base: FakeState = {
    calls: [],
    sentMessages: [],
    daemonUp: true,
    daemonRecovers: false,
    retrievable: true,
    deliverFails: false,
  };
  writeFileSync(statePath, JSON.stringify({ ...base, ...overrides }, null, 2));
}

function readState(): FakeState {
  return JSON.parse(readFileSync(statePath, 'utf8')) as FakeState;
}

function newEngagement(jobId: string): type.Engagement {
  const engagement: type.Engagement = {
    id: uid(),
    okxJobId: jobId,
    okxBuyerAgentId: '9001',
    taskCode: 'abc123',
    listing: 'job-hunt',
    status: 'active',
    startedAt: new Date().toISOString(),
    title: 'Find me a backend job',
  };
  saveEngagement(engagement);
  return engagement;
}

const PAYLOAD = 'Job hunt results\n\n1. Backend Engineer @ Acme — score 89\n2. Platform Engineer @ Globex — score 74';

// ── the happy path still works ─────────────────────────────────────────────

test('delivery: the deliverable is registered on the backend BEFORE the one-way submit', async () => {
  setState({ retrievable: true });
  const engagement = newEngagement('0xjob-happy');

  const res = await submitDeliverable(engagement, PAYLOAD, 'summary');

  assert.equal(res.ok, true);
  assert.equal(res.submitted, true);
  assert.ok(getEngagementById(engagement.id)?.deliveredAt, 'on-chain submit recorded');
  assert.ok(getEngagementById(engagement.id)?.deliverableSentAt, 'delivery confirmed reaching the buyer');

  const calls = readState().calls;
  const attachIdx = calls.findIndex((c) => c.startsWith('onchainos agent task-attach'));
  const deliverIdx = calls.findIndex((c) => c.startsWith('onchainos agent deliver 0xjob-happy'));
  assert.ok(attachIdx >= 0, 'the file is attached to the task (buyer-queryable in list-attachments)');
  assert.ok(deliverIdx >= 0, 'deliver ran');
  // The attach must precede the submit: task-attach is refused once the task
  // leaves `accepted`, so attaching after the submit is impossible.
  assert.ok(attachIdx < deliverIdx, 'attach happens BEFORE the one-way submit, not after');
  assert.ok(
    calls.some((c) => c.startsWith('okx-a2a session history')),
    'the [intent:deliver] broadcast is confirmed in the buyer session stream, not assumed',
  );
});

test('delivery: the deliverable is submitted as a real file, not a bare message', async () => {
  setState({ retrievable: true });
  const engagement = newEngagement('0xjob-file');

  await submitDeliverable(engagement, PAYLOAD, 'summary');

  const deliverCall = readState().calls.find((c) => c.startsWith('onchainos agent deliver'))!;
  assert.match(deliverCall, /--file \S+\.md/, 'a real .md path is passed');
  assert.match(deliverCall, /--agent-id 6658/);

  const stored = getEngagementById(engagement.id)!;
  assert.ok(stored.deliverableFile, 'the artifact path is kept as dispute evidence');
  assert.equal(readFileSync(stored.deliverableFile!, 'utf8'), PAYLOAD, 'the file holds the payload the buyer was owed');
});

// ── the incident: submitted on-chain, payload never arrived ────────────────

test('delivery: an unconfirmed broadcast is NOT reported as success', async () => {
  // The exact incident: `deliver` exits 0, the tx lands, but the [intent:deliver]
  // never reaches the buyer's stream. contentVerified rests on confirming the
  // message in session history — so an unlanded broadcast must fail, not pass.
  setState({ retrievable: true, broadcastFails: true } as never);
  const engagement = newEngagement('0xjob-empty');

  const res = await submitDeliverable(engagement, PAYLOAD, 'summary');

  assert.equal(res.submitted, true, 'the tx did land — submit is one-way');
  assert.notEqual(res.ok, true, 'an unconfirmed broadcast is never success');
  assert.equal(getEngagementById(engagement.id)?.deliverableSentAt, undefined, 'not marked buyer-visible');
  // The task stays in the poller's SUBMITTED-repair loop, which retries the
  // intent every tick until session history confirms it.
});

test('delivery: a confirmed broadcast carries the protocol intent message', async () => {
  setState({ retrievable: true });
  const engagement = newEngagement('0xjob-intent');

  const res = await submitDeliverable(engagement, PAYLOAD, 'summary');

  assert.equal(res.ok, true);
  const sent = readState().sentMessages;
  assert.ok(sent.length >= 1, 'an XMTP intent message was sent');
  assert.ok(sent[0].startsWith('[intent:deliver]'), 'it is the protocol message the buyer agent routes');
  assert.ok(sent[0].includes('fileKey:') || sent[0].includes(PAYLOAD), 'carrying the encrypted file envelope or inline text');
});

test('delivery: repair is skipped when the intent already landed in the buyer stream', async () => {
  setState({ retrievable: true });
  const engagement = newEngagement('0xjob-late');
  // Simulate the [intent:deliver] already confirmed in session history.
  const st = readState();
  st.sentMessages = [`[intent:deliver]\njobId: 0xjob-late\ndeliverableType: file\nfileKey: k`];
  writeFileSync(statePath, JSON.stringify(st, null, 2));

  const res = await repairDeliverable(engagement, PAYLOAD);

  assert.equal(res.ok, true);
  assert.equal(readState().sentMessages.length, 1, 'no DUPLICATE sent when the intent already landed');
  assert.ok(getEngagementById(engagement.id)?.deliverableSentAt);
});

test('delivery: an unaddressable buyer is reported, never silently dropped', async () => {
  setState({ retrievable: false });
  const engagement = newEngagement('0xjob-noagent');
  engagement.okxBuyerAgentId = undefined;
  saveEngagement(engagement);

  const res = await repairDeliverable(engagement, PAYLOAD);

  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /buyer agent id/);
  assert.equal(getEngagementById(engagement.id)?.deliverableSentAt, undefined, 'not marked delivered');
});

// ── never submit into a dead channel ───────────────────────────────────────

test('delivery: nothing is submitted on-chain while the XMTP channel is down', async () => {
  // The submit window is one-way: once the tx lands the task leaves `accepted`
  // and `deliver` is refused forever. Holding is recoverable; an empty
  // submission is not.
  setState({ daemonUp: false, daemonRecovers: false, retrievable: false });
  const engagement = newEngagement('0xjob-down');

  const res = await submitDeliverable(engagement, PAYLOAD, 'summary');

  assert.equal(res.submitted, false);
  assert.equal(res.ok, false);
  const state = readState();
  assert.ok(
    !state.calls.some((c) => c.startsWith('onchainos agent deliver')),
    'deliver must NOT run — this is what produced the empty submission',
  );
  assert.ok(state.calls.some((c) => c === 'okx-a2a daemon start'), 'a restart was attempted first');
  assert.equal(getEngagementById(engagement.id)?.deliveredAt, undefined, 'the task stays deliverable next tick');
});

test('delivery: a recoverable daemon is restarted and the delivery proceeds', async () => {
  setState({ daemonUp: false, daemonRecovers: true, retrievable: true });
  const engagement = newEngagement('0xjob-recover');

  const res = await submitDeliverable(engagement, PAYLOAD, 'summary');

  assert.equal(res.ok, true);
  assert.ok(readState().calls.some((c) => c === 'okx-a2a daemon start'));
});

test('delivery: a rejected submit leaves the task retryable', async () => {
  setState({ deliverFails: true });
  const engagement = newEngagement('0xjob-reject');

  const res = await submitDeliverable(engagement, PAYLOAD, 'summary');

  assert.equal(res.submitted, false);
  assert.equal(res.ok, false);
  assert.equal(getEngagementById(engagement.id)?.deliveredAt, undefined);
});

// ── re-entrancy: never re-submit a task that already went on-chain ─────────

test('delivery: a retry of an already-submitted engagement repairs instead of re-submitting', async () => {
  // The hourly sweep retries failed deliveries. If the submit already landed,
  // `deliver` is refused by the CLI — the retry has to take the repair path or
  // it burns every attempt on a call that cannot succeed.
  const { deliverEngagementOnChain } = await import('../src/okx/server.js');
  setState({ retrievable: false });

  const engagement = newEngagement('0xjob-retry');
  engagement.shortlist = PAYLOAD;
  engagement.deliveredAt = new Date().toISOString(); // submit already on-chain
  saveEngagement(engagement);

  const res = await deliverEngagementOnChain(engagement);

  assert.equal(res.ok, true, 'the payload reached the buyer via repair');
  const state = readState();
  assert.ok(
    !state.calls.some((c) => c.startsWith('onchainos agent deliver')),
    'deliver must NOT be retried — the task has left `accepted`',
  );
  assert.equal(state.sentMessages.length, 1, 'the payload was re-sent over XMTP instead');
});

// ── protocol shape ─────────────────────────────────────────────────────────

test('delivery: the deliver intent matches the format the buyer agent parses', () => {
  const msg = textDeliverIntent('0xabc', 'the goods');
  assert.equal(msg, ['[intent:deliver]', 'jobId: 0xabc', 'deliverableType: text', '- - -', 'the goods', '- - -'].join('\n'));
});

// ── CLI contract: the shape the live tool actually returns ────────────────

test('delivery: retrievability is read from BOTH array shapes the CLI returns', async () => {
  // Verified against the live CLI: a single-job query (`--job-id`, which is
  // always what we send) returns `deliverables`, while the all-jobs listing
  // returns `results`. Reading only `results` made deliverableRetrievable()
  // return false UNCONDITIONALLY in production — so the retrievability check
  // the empty-submission fix depends on never verified anything, and every
  // delivery silently fell through to the XMTP repair path.
  const { countDeliverables } = await import('../src/okx/marketplace.js');
  assert.equal(countDeliverables({ deliverables: [{}] }), 1, 'single-job shape');
  assert.equal(countDeliverables({ results: [{}, {}] }), 2, 'all-jobs shape');
  assert.equal(countDeliverables({ deliverables: [] }), 0);
  assert.equal(countDeliverables(undefined), 0);
});

test('delivery: a verified payload sends exactly one XMTP delivery message without triggering repair', async () => {
  // Now deliverTask explicitly uploads and sends the XMTP [intent:deliver] message
  // right after on-chain submit, confirming delivery without extra repair loops.
  setState({ retrievable: true });
  const engagement = newEngagement('0xjob-noresend');

  const res = await submitDeliverable(engagement, PAYLOAD, 'summary');

  assert.equal(res.ok, true);
  assert.notEqual(res.repaired, true, 'repair path must not run when the payload is verifiably there');
  assert.equal(readState().sentMessages.length, 1, 'exactly one XMTP delivery message sent');
  assert.ok(readState().sentMessages[0].includes('[intent:deliver]'));
});

// ── the silent-transport bug: no XMTP session, 100% send failure ──────────

test('delivery: an outbound message establishes the XMTP session first', async () => {
  // Production ran its entire lifetime with zero sessions. Every send was
  // queued, reported ok, then rejected by the daemon with "Cannot infer local
  // XMTP address" — so the criteria request, the nudge and the
  // [intent:deliver] carrying the shortlist all died silently.
  const { chatToBuyer } = await import('../src/okx/marketplace.js');
  setState({ retrievable: true });

  const res = await chatToBuyer('0xjob-session', '9001', 'hello buyer');

  assert.equal(res.ok, true);
  const s = readState();
  assert.ok(s.calls.some((c) => c.startsWith('okx-a2a session create')), 'session created before sending');
  assert.equal(s.sentMessages.length, 1, 'and the message actually went out');
  assert.equal(s.sentMessages[0], 'hello buyer');
});

test('delivery: a send that cannot get a session reports failure, never false success', async () => {
  const { chatToBuyer } = await import('../src/okx/marketplace.js');
  setState({ retrievable: true, sessionCreateFails: true } as never);

  const res = await chatToBuyer('0xjob-nosession', '9001', 'hello buyer');

  assert.equal(res.ok, false, 'silent success here is what hid a 0% delivery rate');
  assert.match(res.error ?? '', /session/i);
  assert.equal(readState().sentMessages.length, 0);
});

test('delivery: nothing is submitted on-chain when the payload could not be routed', async () => {
  // The submit is one-way. Submitting while the [intent:deliver] cannot leave
  // produces exactly the empty submission the first buyer rejected.
  setState({ retrievable: true, sessionCreateFails: true } as never);
  const engagement = newEngagement('0xjob-unroutable');

  const res = await submitDeliverable(engagement, PAYLOAD, 'summary');

  assert.equal(res.submitted, false);
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /session/i);
  assert.ok(
    !readState().calls.some((c) => c.startsWith('onchainos agent deliver')),
    'deliver must not run when its payload leg cannot succeed',
  );
  assert.equal(getEngagementById(engagement.id)?.deliveredAt, undefined, 'task stays deliverable');
});

test('delivery: file deliver intent format matches OKX A2A specification', () => {
  const intent = fileDeliverIntent('0x123', {
    fileKey: '0x123/key-456',
    digest: 'digest789',
    salt: 'saltabc',
    nonce: 'noncedef',
    secret: 'secretxyz',
    filename: 'report.md',
  });
  assert.equal(
    intent,
    [
      '[intent:deliver]',
      'jobId: 0x123',
      'deliverableType: file',
      'fileKey: 0x123/key-456',
      'digest: digest789',
      'salt: saltabc',
      'nonce: noncedef',
      'secret: secretxyz',
      'filename: report.md',
    ].join('\n'),
  );
});

test('delivery: uploadFileDeliverable uploads attachment via okx-a2a file upload', async () => {
  setState({ retrievable: true });
  const samplePath = join(workDir, 'sample.md');
  writeFileSync(samplePath, PAYLOAD);
  const res = await uploadFileDeliverable(samplePath, '0xjob-upload');
  assert.equal(res.ok, true);
  assert.equal(res.data?.fileKey, '0xjob-upload/key-123');
  assert.equal(res.data?.digest, 'digest123');
  const calls = readState().calls;
  assert.ok(calls.some((c) => c.includes('okx-a2a file upload --file-path')));
});

test('delivery: a2aDeliveryMessageBroadcast checks session history for deliver intent', async () => {
  setState({ retrievable: true });
  const jobId = '0xjob-broadcast';
  const engagement = newEngagement(jobId);
  await submitDeliverable(engagement, PAYLOAD, 'summary');
  const isBroadcast = await a2aDeliveryMessageBroadcast(jobId, engagement.okxBuyerAgentId);
  assert.equal(isBroadcast, true, 'delivery message present in session history');
});

test('delivery: extracts buyer communication address from task details when missing on engagement', async () => {
  const { extractCounterpartyAgentId } = await import('../src/okx/marketplace.js');
  const address = '0x80f831639b0B8E27aA77195CdD10A5313926A19E';
  assert.equal(extractCounterpartyAgentId({ counterpartyAgentId: address }), address);
  assert.equal(extractCounterpartyAgentId({ buyerAddress: address }), address);
  assert.equal(extractCounterpartyAgentId({ creatorAddress: address }), address);
  assert.equal(extractCounterpartyAgentId({ buyerAgentId: address }), address);
});

// ── CLI output parsing: the bug that made every delivery unconfirmable ─────

test('delivery: pretty-printed JSON arrays parse — a bare "{" line must not discard the output', async () => {
  // `session history` prints a multi-line JSON ARRAY. The old extractor took
  // "the last line starting with {", which for pretty output is the bare
  // string "{" — its parse failure threw into the catch block and returned
  // raw:''. chatHistory therefore reported EMPTY history forever, so a
  // delivered payload could never be confirmed and was re-sent to the buyer
  // every 30 seconds. Verified against real CLI output shapes.
  const { parseCliJson } = await import('../src/okx/marketplace.js');

  const prettyArray = '[\n  {\n    "id": "a",\n    "content": "hello"\n  },\n  {\n    "id": "b"\n  }\n]';
  const arr = parseCliJson(prettyArray) as Array<{ id: string }>;
  assert.ok(Array.isArray(arr), 'a pretty-printed array must parse as an array');
  assert.equal(arr.length, 2);
  assert.equal(arr[0].id, 'a');

  // Pretty-printed object.
  const prettyObj = parseCliJson('{\n  "ok": true,\n  "fileKey": "k"\n}') as { fileKey: string };
  assert.equal(prettyObj.fileKey, 'k');

  // The original shape must still work: log lines, then single-line JSON.
  const logged = parseCliJson('[info] starting\n[info] done\n{"ok":true,"data":{"x":1}}') as { ok: boolean };
  assert.equal(logged.ok, true);

  // Non-JSON output is reported as absent, not as a crash.
  assert.equal(parseCliJson('Task status: submitted\n  title: x'), undefined);
  assert.equal(parseCliJson(''), undefined);
});

test('delivery: the canonical artifact survives — CLIs get a disposable copy', async () => {
  // Verified in production: after a delivery the original .md was GONE from
  // $DATA_DIR/deliverables. The tooling consumes the file it is handed, which
  // destroys the dispute evidence and leaves the repair path unable to re-send
  // as a file. The CLI must never be given our only copy.
  setState({ retrievable: true });
  const engagement = newEngagement('0xjob-artifact');

  await submitDeliverable(engagement, PAYLOAD, 'summary');

  const stored = getEngagementById(engagement.id)!;
  assert.ok(stored.deliverableFile, 'the artifact path is recorded');
  assert.equal(readFileSync(stored.deliverableFile!, 'utf8'), PAYLOAD, 'and the artifact still exists afterwards');

  // Every CLI that touches a file must have been handed the copy, not it.
  const calls = readState().calls;
  const fileArgs = calls
    .filter((c) => c.includes('--file'))
    .map((c) => c.split(/--file(?:-path)? /)[1]?.split(' ')[0])
    .filter(Boolean);
  assert.ok(fileArgs.length > 0, 'a file was passed to the CLI');
  for (const arg of fileArgs) {
    assert.notEqual(arg, stored.deliverableFile, 'the canonical artifact must never be handed to a CLI');
  }
});
