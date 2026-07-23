/**
 * Full ASP task lifecycle, driven through the REAL poller.
 *
 * Every other suite tests a unit. This one asserts the assembled sequence that
 * a live task actually takes — accepted → (no brief? ask) → brief arrives over
 * chat → hunt → deliver → buyer can retrieve — because the production failures
 * so far have all been in the seams between working parts, not inside them.
 *
 * The `onchainos` and `okx-a2a` binaries are replaced by fixtures whose output
 * shapes were verified against the live CLIs, notably:
 *   - active-tasks returns title + budget and NO description field, which is
 *     why the buyer's brief has to come from chat
 *   - task-deliverable-list --job-id returns `deliverables`, not `results`
 *
 * The job source is the built-in mock (no network), so the assertions are about
 * the pipeline, not about what a job board happens to be advertising today.
 */
process.env.DATABASE_PATH = ':memory:';
process.env.ANTHROPIC_API_KEY = ''; // production parity: llm=false, heuristic path
process.env.ADZUNA_APP_ID = '';
process.env.ADZUNA_APP_KEY = '';
process.env.USAJOBS_API_KEY = '';
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.OKX_ASP_AGENT_ID = '6658';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const work = mkdtempSync(join(tmpdir(), 'legwork-lifecycle-'));
const statePath = join(work, 'state.json');
const fixtures = new URL('./fixtures/', import.meta.url).pathname;

process.env.FAKE_CLI_STATE = statePath;
process.env.ONCHAINOS_BIN = join(fixtures, 'fake-onchainos-full.mjs');
process.env.OKX_A2A_BIN = join(fixtures, 'fake-okx-a2a.mjs');
process.env.DATA_DIR = work;

const db = await import('../src/db.js');
const { handleEnvelope } = await import('../src/okx/server.js');
const { pollOnce } = await import('../src/okx/poller.js');

interface State {
  calls: string[];
  sentMessages: string[];
  daemonUp: boolean;
  retrievable: boolean;
  deliveredFile: string | null;
  tasks: Array<Record<string, unknown>>;
}

const JOB = '0xLIFECYCLE';

function reset(statusCode: number): void {
  writeFileSync(
    statePath,
    JSON.stringify(
      {
        calls: [], sentMessages: [], daemonUp: true, daemonRecovers: false,
        retrievable: false, deliverFails: false, deliveredFile: null,
        // Exactly what the live marketplace returns — note: no description.
        tasks: [{
          jobId: JOB, title: 'Job hunt shortlist help', statusCode, status: 'accepted',
          tokenAmount: '0.25', tokenSymbol: 'USDT', myRole: 'asp', myAgentId: '6658',
          counterpartyAgentId: '1908',
        }],
      },
      null,
      2,
    ),
  );
}

const read = (): State => JSON.parse(readFileSync(statePath, 'utf8')) as State;

function seedEngagement(): void {
  db.saveEngagement({
    id: db.uid(), okxJobId: JOB, okxBuyerAgentId: '1908', taskCode: 'tc-life',
    listing: 'job-hunt', status: 'active', startedAt: db.now(),
    title: 'Job hunt shortlist help', claimedAt: db.now(), appliedAt: db.now(),
  } as never);
}

const BUYER_BRIEF =
  'Senior backend engineer. TypeScript, Node, Postgres, AWS. $110k+ base. remote-US or Austin.';

test('lifecycle: an accepted task with no brief asks the buyer instead of delivering', async () => {
  // The live failure: the marketplace supplies no description, so hunting on
  // the title alone returned nothing and an empty shortlist was submitted —
  // irreversibly, because `submitted` is one-way.
  reset(1); // TaskStatus.ACCEPTED
  seedEngagement();

  await pollOnce({ bot: null });

  const s = read();
  assert.ok(!s.calls.some((c) => c.includes('agent deliver')), 'must NOT submit without criteria');
  assert.equal(s.sentMessages.length, 1, 'exactly one request for criteria');
  assert.match(s.sentMessages[0], /criteria/i);
  assert.match(s.sentMessages[0], /salary/i, 'names the fields that were missing');
  assert.equal(db.getEngagementByJob(JOB)?.deliveredAt, undefined, 'task stays deliverable');
});

test('lifecycle: the ask is sent once, not on every 30-second tick', async () => {
  await pollOnce({ bot: null });
  assert.equal(read().sentMessages.length, 1, 'a bot that repeats itself every tick reads as broken');
});

test('lifecycle: brief from chat → hunt → deliverable with real ranked listings', async () => {
  // The buyer's requirements arrive over A2A chat — the only channel that
  // carries them — and must survive into the hunt.
  const reply = handleEnvelope({
    msgType: 'a2a-agent-chat', jobId: JOB,
    sender: { role: 'user', agentId: '1908' },
    parts: [{ kind: 'text', text: BUYER_BRIEF }],
  } as never) as { reply?: string };

  assert.ok(db.getEngagementByJob(JOB)?.brief?.includes('Postgres'), 'brief captured from chat');
  assert.doesNotMatch(String(reply.reply), /t\.me/, 'the reply must not be a bare funnel link');

  await pollOnce({ bot: null });

  const s = read();
  const engagement = db.getEngagementByJob(JOB)!;

  const deliverCall = s.calls.find((c) => c.includes('agent deliver'));
  assert.ok(deliverCall, 'deliver ran once criteria existed');
  assert.match(deliverCall!, /--file \S+\.md/, 'submitted as a real file');
  assert.ok(s.calls.some((c) => c.includes('task-deliverable-list')), 'retrievability verified, not assumed');
  assert.ok(engagement.deliveredAt, 'submit recorded');
  assert.ok(engagement.deliverableSentAt, 'buyer can actually retrieve it');

  // The payload is the point: it must contain ranked listings, not an apology.
  const payload = readFileSync(s.deliveredFile!, 'utf8');
  const ranked = payload.match(/^\d+\.\s\[\d+\/100\]/gm) ?? [];
  assert.ok(ranked.length > 0, `delivered payload has no ranked listings:\n${payload.slice(0, 400)}`);
  assert.doesNotMatch(payload, /top 0 of 0/, 'the exact string the buyer rejected');
  assert.ok(payload.indexOf('Job hunt results') < payload.indexOf('t.me'), 'results lead, funnel link trails');
});

test('lifecycle: a hunt that matches nothing is withheld, not submitted empty', async () => {
  // Reproduces production's shape: a live job source is configured but yields
  // nothing (there it was a nonsense query built from the task title; here the
  // credentials are rejected). Either way the scan returns zero postings — and
  // the mock fallback is deliberately NOT used, because it only applies when no
  // source is configured at all. What matters is what we do with the zero.
  const { config } = await import('../src/config.js');
  config.adzuna.appId = 'test-invalid';
  config.adzuna.appKey = 'test-invalid';

  try {
    reset(1);
    const engagement = db.getEngagementByJob(JOB)!;
    engagement.deliveredAt = undefined;
    engagement.deliverableSentAt = undefined;
    engagement.noMatchNoticeAt = undefined;
    engagement.brief = BUYER_BRIEF;
    db.saveEngagement(engagement);

    await pollOnce({ bot: null });

    const s = read();
    assert.ok(!s.calls.some((c) => c.includes('agent deliver')), 'an empty result must never be submitted');
    assert.ok(
      s.sentMessages.some((m) => /no postings matched/i.test(m)),
      `the buyer is told what was searched; got: ${JSON.stringify(s.sentMessages)}`,
    );
    assert.ok(
      s.sentMessages.some((m) => /\$110,000\+ base/.test(m)),
      'the echo repeats the parsed criteria, including the salary floor',
    );
    assert.equal(db.getEngagementByJob(JOB)?.deliveredAt, undefined, 'task stays deliverable for a retry');
  } finally {
    config.adzuna.appId = '';
    config.adzuna.appKey = '';
  }
});
