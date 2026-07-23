import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { audit } from '../db.js';

const run = promisify(execFile);

/**
 * OKX Task Marketplace client — the ASP (seller) side of the protocol.
 *
 * Legwork used to be purely reactive: it did nothing until OKX pushed an
 * envelope to /okx/a2a. That is not how the marketplace works. A task that
 * names this agent as provider sits in `created` until the ASP retrieves it
 * and claims it; if nobody claims it, the backend expires it (status 8) and
 * the buyer sees a provider that timed out.
 *
 * So the agent has to pull. Every command here is `onchainos agent …` run
 * against the SERVICE's own wallet session (not a per-user one — see
 * wallet/okxWallet.ts for that), identified by OKX_ASP_AGENT_ID.
 *
 * Command semantics come from the OKX task state machine:
 *   status 0 created → 1 accepted → 2 submitted → 6 completed
 *   (7 close / 8 expired / 9 refunded are terminal failures)
 */

const CLI = process.env.ONCHAINOS_BIN || 'onchainos';
/** The XMTP side-car. Separate binary — it carries the deliverable payload. */
const A2A_CLI = process.env.OKX_A2A_BIN || 'okx-a2a';
const TIMEOUT_MS = Number(process.env.OKX_CLI_TIMEOUT_MS ?? 90_000);

export interface CliResult<T> {
  ok: boolean;
  data?: T;
  /** Raw stdout — several CLI commands print human text rather than JSON. */
  raw: string;
  error?: string;
}

/** Last JSON object printed on stdout; the CLI logs plain text above it. */
function lastJson(stdout: string): string | undefined {
  return stdout.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop();
}

async function cli<T>(args: string[], timeoutMs = TIMEOUT_MS): Promise<CliResult<T>> {
  const env = { ...process.env };
  // The service's own agent session. Separate from per-user wallet homes so a
  // Telegram user's sign-in can never be used to act as the ASP identity.
  if (config.okx.home) env.ONCHAINOS_HOME = config.okx.home;

  try {
    const { stdout } = await run(CLI, ['agent', ...args], { env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    const line = lastJson(stdout);
    if (!line) return { ok: true, raw: stdout }; // text-mode command (e.g. recommend-task)
    const parsed = JSON.parse(line) as { ok?: boolean; data?: T; error?: string; msg?: string; message?: string };
    return {
      ok: parsed.ok !== false,
      data: parsed.data,
      raw: stdout,
      error: parsed.ok === false ? parsed.error ?? parsed.msg ?? parsed.message ?? 'command failed' : undefined,
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; killed?: boolean; message?: string };
    const line = lastJson(e.stdout ?? '');
    if (line) {
      try {
        const parsed = JSON.parse(line) as { error?: string; msg?: string; message?: string };
        return { ok: false, raw: e.stdout ?? '', error: parsed.error ?? parsed.msg ?? parsed.message ?? 'command failed' };
      } catch {
        /* fall through */
      }
    }
    if (e.killed) return { ok: false, raw: e.stdout ?? '', error: `TIMEOUT after ${timeoutMs}ms` };
    return { ok: false, raw: e.stdout ?? '', error: (e.stderr || e.message || String(err)).split('\n')[0].slice(0, 300) };
  }
}

/** Run the XMTP side-car. Same env isolation as `cli`, different binary. */
async function a2a(args: string[], timeoutMs = TIMEOUT_MS): Promise<{ ok: boolean; raw: string; error?: string }> {
  const env = { ...process.env };
  if (config.okx.home) env.ONCHAINOS_HOME = config.okx.home;
  try {
    const { stdout } = await run(A2A_CLI, args, { env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    const line = lastJson(stdout);
    if (!line) return { ok: true, raw: stdout };
    const parsed = JSON.parse(line) as { ok?: boolean; error?: string; message?: string };
    return { ok: parsed.ok !== false, raw: stdout, error: parsed.ok === false ? parsed.error ?? parsed.message : undefined };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; killed?: boolean; message?: string };
    if (e.killed) return { ok: false, raw: e.stdout ?? '', error: `TIMEOUT after ${timeoutMs}ms` };
    return { ok: false, raw: e.stdout ?? '', error: (e.stderr || e.message || String(err)).split('\n')[0].slice(0, 300) };
  }
}

// ── task shapes ────────────────────────────────────────────────────────────

/** OKX task status ints — see the task state machine. */
export const TaskStatus = {
  CREATED: 0,
  ACCEPTED: 1,
  SUBMITTED: 2,
  REJECTED: 3,
  DISPUTED: 4,
  ADMIN_STOPPED: 5,
  COMPLETED: 6,
  CLOSED: 7,
  EXPIRED: 8,
  REFUNDED: 9,
} as const;

export const TERMINAL_STATUSES: number[] = [
  TaskStatus.ADMIN_STOPPED,
  TaskStatus.COMPLETED,
  TaskStatus.CLOSED,
  TaskStatus.EXPIRED,
  TaskStatus.REFUNDED,
];

export interface MarketplaceTask {
  jobId: string;
  title: string;
  statusCode: number;
  status?: string;
  tokenAmount?: string;
  tokenSymbol?: string;
  /** The buyer's User Agent id. */
  counterpartyAgentId?: string;
  myAgentId?: string;
  description?: string;
  /** true when this task already names us as provider (private/designated). */
  designated: boolean;
}

// ── read paths ─────────────────────────────────────────────────────────────

/**
 * Tasks where THIS account is the provider — the ones that expire if we do
 * nothing. Returns JSON, so this is the poller's primary source of truth.
 */
export async function activeTasks(): Promise<{ ok: boolean; tasks: MarketplaceTask[]; error?: string }> {
  const res = await cli<{ tasks?: Array<Record<string, unknown>> }>(['active-tasks', '--role', 'asp', '--include-terminal']);
  if (!res.ok) return { ok: false, tasks: [], error: res.error };
  const rows = res.data?.tasks ?? [];
  const mine = rows
    .filter((t) => String(t.myRole ?? 'asp') === 'asp')
    .filter((t) => !config.okx.aspAgentId || String(t.myAgentId ?? '') === config.okx.aspAgentId)
    .map((t) => ({
      jobId: String(t.jobId ?? ''),
      title: String(t.title ?? ''),
      statusCode: Number(t.statusCode ?? -1),
      status: t.status ? String(t.status) : undefined,
      tokenAmount: t.tokenAmount ? String(t.tokenAmount) : undefined,
      tokenSymbol: t.tokenSymbol ? String(t.tokenSymbol) : undefined,
      counterpartyAgentId: t.counterpartyAgentId ? String(t.counterpartyAgentId) : undefined,
      myAgentId: t.myAgentId ? String(t.myAgentId) : undefined,
      // active-tasks only ever returns tasks already routed to this agent.
      designated: true,
    }))
    .filter((t) => t.jobId);
  return { ok: true, tasks: mine };
}

/**
 * Public tasks the marketplace recommends for this agent's skill profile.
 * Prints human-readable text (not JSON), hence the line parser.
 *
 * Only useful once the agent's listing is approved — while it is under review
 * the backend answers `AgentApi.agentServices failed`, which is expected and
 * must not stop the poll cycle.
 */
export async function recommendedTasks(): Promise<{ ok: boolean; tasks: MarketplaceTask[]; error?: string }> {
  if (!config.okx.aspAgentId) return { ok: false, tasks: [], error: 'OKX_ASP_AGENT_ID not set' };
  const res = await cli<unknown>(['recommend-task', '--agent-id', config.okx.aspAgentId]);
  if (!res.ok) return { ok: false, tasks: [], error: res.error };
  return { ok: true, tasks: parseRecommendedTasks(res.raw) };
}

/**
 * Parse `recommend-task`'s text block into tasks.
 *
 *   1. jobId: 0xabc…
 *      Title:      Find me a job
 *      Description: …
 *      Budget:     1 (token: 0x…)
 *
 * Exported for tests: the CLI's text format is the fragile part of this
 * integration, so it is pinned by a fixture rather than trusted.
 */
export function parseRecommendedTasks(raw: string): MarketplaceTask[] {
  const tasks: MarketplaceTask[] = [];
  let current: MarketplaceTask | undefined;
  for (const line of raw.split('\n')) {
    const jobId = /jobId:\s*(0x[a-fA-F0-9]+|[\w-]+)/.exec(line);
    if (jobId) {
      if (current) tasks.push(current);
      current = { jobId: jobId[1], title: '', statusCode: TaskStatus.CREATED, designated: false };
      continue;
    }
    if (!current) continue;
    const title = /^\s*Title:\s*(.+)$/.exec(line);
    if (title) current.title = title[1].trim();
    const desc = /^\s*Description:\s*(.+)$/.exec(line);
    if (desc) current.description = desc[1].trim();
    const budget = /^\s*Budget:\s*([\d.]+)/.exec(line);
    if (budget) current.tokenAmount = budget[1];
  }
  if (current) tasks.push(current);
  return tasks.filter((t) => t.jobId);
}

/** Full detail for one task — used to read the buyer's brief before working. */
export async function taskDetail(jobId: string): Promise<{ ok: boolean; raw: string; error?: string }> {
  const args = ['status', jobId];
  if (config.okx.aspAgentId) args.push('--agent-id', config.okx.aspAgentId);
  const res = await cli<unknown>(args);
  return { ok: res.ok, raw: res.raw, error: res.error };
}

// ── write paths ────────────────────────────────────────────────────────────

/**
 * Claim step 1 — open the negotiation channel with the buyer's User Agent.
 *
 * `contact-user` creates the XMTP group and sends the canonical opener in one
 * call. This is the non-financial half of claiming: it tells the buyer a
 * provider picked the task up, which is precisely the signal that was missing.
 */
export async function contactUser(jobId: string): Promise<{ ok: boolean; error?: string }> {
  if (!config.okx.aspAgentId) return { ok: false, error: 'OKX_ASP_AGENT_ID not set' };
  const res = await cli<unknown>(['contact-user', jobId, '--agent-id', config.okx.aspAgentId]);
  audit('okx-marketplace', res.ok ? 'CONTACTED' : 'CONTACT_FAILED', `job=${jobId} ${res.error ?? ''}`.trim());
  return { ok: res.ok, error: res.error };
}

/**
 * Claim step 2 — apply on-chain at the task's own budget.
 *
 * Only ever called for tasks that ALREADY designate this agent as provider:
 * the buyer picked us, so applying is the response they are waiting for, and
 * without it the task expires. Never called on cold-start discovery of public
 * tasks — there the User Agent must designate us first.
 */
export async function applyForTask(
  jobId: string,
  tokenAmount: string,
  tokenSymbol: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!config.okx.aspAgentId) return { ok: false, error: 'OKX_ASP_AGENT_ID not set' };
  if (!(Number(tokenAmount) > 0)) return { ok: false, error: `refusing to apply for free (amount=${tokenAmount})` };
  const res = await cli<unknown>([
    'apply', jobId,
    '--token-amount', tokenAmount,
    '--token-symbol', tokenSymbol,
    '--agent-id', config.okx.aspAgentId,
  ]);
  audit('okx-marketplace', res.ok ? 'APPLIED' : 'APPLY_FAILED', `job=${jobId} ${tokenAmount} ${tokenSymbol} ${res.error ?? ''}`.trim());
  return { ok: res.ok, error: res.error };
}

export interface DeliverOutcome {
  /** The submit tx is on-chain. The task is now `submitted` and cannot be re-delivered. */
  submitted: boolean;
  /**
   * The deliver pipeline's payload legs completed — the CLI records the
   * submitted copy in the local deliverables manifest only after the upload
   * and XMTP send succeed, and `task-deliverable-list` reads that manifest.
   * (It is a local ledger, not the buyer's inbox — their copy appears in
   * THEIR manifest when their agent processes the [intent:deliver].)
   */
  contentVerified: boolean;
  error?: string;
}

/**
 * Submit the deliverable. Only valid while the task is `accepted`.
 *
 * `agent deliver` does FOUR things behind one exit code: upload the file,
 * xmtp-send `[intent:deliver]` to the buyer, submit on-chain, and save locally.
 * The on-chain leg can succeed while the XMTP leg silently fails (daemon down),
 * which the buyer experiences as a task that reached `submitted` with nothing
 * in it — an empty submission they then reject, with no escrow ever funded.
 *
 * So a zero exit code is NOT proof of delivery. Every call verifies that the
 * payload actually landed, and reports the two legs separately so the caller
 * can repair the payload leg without re-submitting on-chain.
 */
export async function deliverTask(
  jobId: string,
  opts: { file: string; message: string },
): Promise<DeliverOutcome> {
  if (!config.okx.aspAgentId) return { submitted: false, contentVerified: false, error: 'OKX_ASP_AGENT_ID not set' };

  const res = await cli<unknown>([
    'deliver', jobId,
    // A real file, not `--deliverable-text`: the CLI converts any text over
    // 200 chars into a temp .md anyway, and an explicit path gives us a stable
    // filename plus a local artifact to fall back on and to keep as evidence.
    '--file', opts.file,
    '--message', opts.message,
    '--agent-id', config.okx.aspAgentId,
  ]);
  if (!res.ok) {
    audit('okx-marketplace', 'DELIVER_FAILED', `job=${jobId} ${res.error ?? ''}`.trim());
    return { submitted: false, contentVerified: false, error: res.error };
  }

  const contentVerified = await deliverableRetrievable(jobId);
  audit(
    'okx-marketplace',
    contentVerified ? 'DELIVERED_ONCHAIN' : 'DELIVERED_EMPTY',
    `job=${jobId} contentVerified=${contentVerified}`,
  );
  return { submitted: true, contentVerified };
}

/**
 * Is there a deliverable the buyer can actually retrieve for this job?
 *
 * `deliver` persists the payload as its last step, so an empty list after a
 * successful submit means the payload legs (upload / xmtp) did not complete —
 * the precise state that looks delivered on-chain and empty to the buyer.
 */
export async function deliverableRetrievable(jobId: string): Promise<boolean> {
  const res = await cli<{ deliverables?: unknown[]; results?: unknown[] }>([
    'task-deliverable-list', '--job-id', jobId, '--role', 'asp',
  ]);
  if (!res.ok) return false;
  // The CLI names this array differently depending on the mode: a single-job
  // query (`--job-id`, which is always what we send) returns `deliverables`,
  // while the all-jobs listing returns `results`. Reading only `results` meant
  // this returned false unconditionally — so the retrievability check that the
  // empty-submission fix depends on never actually verified anything, and every
  // delivery fell through to the XMTP repair path. Verified against the live
  // CLI: `--job-id` → {"data":{"deliverables":[]}}, no job id → {"results":[]}.
  return countDeliverables(res.data) > 0;
}

/** Length of whichever array shape this CLI version returned. */
export function countDeliverables(data: { deliverables?: unknown[]; results?: unknown[] } | undefined): number {
  return (data?.deliverables?.length ?? 0) || (data?.results?.length ?? 0);
}

/**
 * The `[intent:deliver]` payload the buyer's agent parses, in its inline-text
 * form. Emitted by `deliver` itself; rebuilt here for the repair path so a
 * re-send is a protocol message rather than an unstructured chat line the
 * buyer's agent would never route to its review flow.
 */
export function textDeliverIntent(jobId: string, content: string): string {
  return ['[intent:deliver]', `jobId: ${jobId}`, 'deliverableType: text', '- - -', content, '- - -'].join('\n');
}

/**
 * Re-send the deliverable payload over XMTP.
 *
 * The repair path only. Normal delivery must go through `deliverTask` — the
 * playbook is explicit that `deliver` owns the peer notification and a manual
 * duplicate would double-notify. This exists for the one case the playbook
 * does not cover: the submit landed but the payload leg did not, so the task
 * is stuck in `submitted` where `deliver` is no longer legal.
 */
export async function resendDeliverable(
  jobId: string,
  toAgentId: string,
  content: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await a2a([
    'xmtp-send',
    '--job-id', jobId,
    '--to-agent-id', toAgentId,
    '--message', textDeliverIntent(jobId, content),
    '--json',
  ]);
  audit('okx-marketplace', res.ok ? 'DELIVERABLE_RESENT' : 'DELIVERABLE_RESEND_FAILED', `job=${jobId} ${res.error ?? ''}`.trim());
  return res;
}

/**
 * Send a plain chat message to the buyer's agent in the task's XMTP group.
 *
 * Unlike `resendDeliverable` this carries no `[intent:deliver]` envelope — it
 * is ordinary negotiation traffic, used to ask for missing requirements rather
 * than to hand over work.
 */
export async function chatToBuyer(
  jobId: string,
  toAgentId: string,
  message: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await a2a([
    'xmtp-send',
    '--job-id', jobId,
    '--to-agent-id', toAgentId,
    '--message', message,
    '--json',
  ]);
  audit('okx-marketplace', res.ok ? 'BUYER_CHAT_SENT' : 'BUYER_CHAT_FAILED', `job=${jobId} ${res.error ?? ''}`.trim());
  return res;
}

/** Decline a designated task we cannot serve (off-chain, no signing). */
export async function rejectTask(jobId: string): Promise<{ ok: boolean; error?: string }> {
  if (!config.okx.aspAgentId) return { ok: false, error: 'OKX_ASP_AGENT_ID not set' };
  const res = await cli<unknown>(['asp-reject', jobId, '--agent-id', config.okx.aspAgentId]);
  audit('okx-marketplace', res.ok ? 'DECLINED' : 'DECLINE_FAILED', `job=${jobId} ${res.error ?? ''}`.trim());
  return { ok: res.ok, error: res.error };
}

/**
 * Report the agent as online.
 *
 * `recommend-task` / `find-jobs` only consider agents whose heartbeat is
 * fresh, so a long-running ASP that never beats drops out of task matching
 * even though its endpoint is up.
 */
export async function heartbeat(): Promise<boolean> {
  const res = await cli<unknown>(['heartbeat', '--chain-index', String(config.okx.chainIndex)], 30_000);
  return res.ok;
}

// ── readiness ──────────────────────────────────────────────────────────────

export interface GateCheck {
  ready: boolean;
  wallet: boolean;
  identity: boolean;
  communication: boolean;
  agentId?: string;
  error?: string;
}

/**
 * Read-only diagnostic: is the wallet logged in, is there an ASP identity, is
 * the A2A channel up? Run once at startup so a misconfigured deployment says
 * so in the logs instead of silently never claiming anything.
 */
export async function gateCheck(): Promise<GateCheck> {
  const res = await cli<{
    ready?: boolean;
    wallet?: { ok?: boolean };
    identity?: { ok?: boolean; agentId?: string };
    communication?: { ok?: boolean };
  }>(['gate-check', '--role', 'asp'], 120_000);
  if (!res.ok || !res.data) {
    return { ready: false, wallet: false, identity: false, communication: false, error: res.error ?? 'gate-check returned no data' };
  }
  const d = res.data;
  return {
    ready: Boolean(d.ready),
    wallet: Boolean(d.wallet?.ok),
    identity: Boolean(d.identity?.ok),
    communication: Boolean(d.communication?.ok),
    agentId: d.identity?.agentId,
  };
}

/**
 * Is the XMTP daemon up right now?
 *
 * Cheap enough to run immediately before every delivery, which `gateCheck` is
 * not (it shells out to `okx-a2a doctor` and takes tens of seconds). Delivery
 * is the one action that is unrecoverable if the payload channel is down —
 * once the submit tx lands the task leaves `accepted` and `deliver` is refused
 * forever — so it gets its own pre-flight rather than trusting a flag sampled
 * at startup.
 */
export async function a2aDaemonUp(): Promise<boolean> {
  const res = await a2a(['status'], 20_000);
  return res.ok && /running/i.test(res.raw);
}

/** Bring the XMTP daemon back up. Idempotent; safe to call when already running. */
export async function startA2aDaemon(): Promise<boolean> {
  const res = await a2a(['daemon', 'start'], 60_000);
  audit('okx-marketplace', res.ok ? 'A2A_DAEMON_STARTED' : 'A2A_DAEMON_START_FAILED', res.error ?? '');
  return res.ok;
}

/** Is the onchainos CLI present at all? */
export async function cliAvailable(): Promise<boolean> {
  try {
    await run(CLI, ['--version'], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}
