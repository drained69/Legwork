import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/**
 * Extract the JSON result from CLI output.
 *
 * Two shapes must both work: a command that prints log lines and then a
 * single-line JSON object, and one that prints a pretty-printed object or
 * ARRAY spanning many lines. Scanning for "the last line starting with {"
 * handles only the first — on pretty-printed output it returns the bare
 * string "{", whose parse failure previously threw into the catch block and
 * discarded stdout entirely. That made `session history` look permanently
 * empty, so a delivered payload could never be confirmed and was re-sent to
 * the buyer on every 30s tick.
 */
export function parseCliJson(stdout: string): unknown | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  // Whole-output first: the only shape that can represent a multi-line array.
  try {
    return JSON.parse(trimmed);
  } catch {
    /* not a single JSON document — fall back to line scanning */
  }
  const lines = trimmed.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* a fragment such as a bare "{" — keep looking backwards */
    }
  }
  return undefined;
}

async function cli<T>(args: string[], timeoutMs = TIMEOUT_MS): Promise<CliResult<T>> {
  const env = { ...process.env };
  // The service's own agent session. Separate from per-user wallet homes so a
  // Telegram user's sign-in can never be used to act as the ASP identity.
  if (config.okx.home) env.ONCHAINOS_HOME = config.okx.home;

  try {
    const { stdout } = await run(CLI, ['agent', ...args], { env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    const json = parseCliJson(stdout);
    if (json === undefined) return { ok: true, raw: stdout }; // text-mode command (e.g. recommend-task)
    const parsed = json as { ok?: boolean; data?: T; error?: string; msg?: string; message?: string };
    return {
      ok: parsed.ok !== false,
      data: parsed.data,
      raw: stdout,
      error: parsed.ok === false ? parsed.error ?? parsed.msg ?? parsed.message ?? 'command failed' : undefined,
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; killed?: boolean; message?: string };
    // A non-zero exit still often carries a JSON error body on stdout.
    const failure = parseCliJson(e.stdout ?? '') as { error?: string; msg?: string; message?: string } | undefined;
    if (failure && (failure.error || failure.msg || failure.message)) {
      return { ok: false, raw: e.stdout ?? '', error: failure.error ?? failure.msg ?? failure.message };
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
    const json = parseCliJson(stdout);
    if (json === undefined) return { ok: true, raw: stdout };
    // An array result (e.g. `session history`) carries no `ok` field — absence
    // means success, not failure.
    const parsed = json as { ok?: boolean; error?: string; message?: string };
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

export function extractCounterpartyAgentId(t: Record<string, unknown>): string | undefined {
  const val =
    t.counterpartyAgentId ??
    t.buyerAgentId ??
    t.buyerAddress ??
    t.creatorAddress ??
    t.creatorAgentId ??
    t.senderAddress ??
    t.userAddress;
  return val ? String(val) : undefined;
}

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
      counterpartyAgentId: extractCounterpartyAgentId(t),
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
export async function taskDetail(jobId: string): Promise<{ ok: boolean; task?: MarketplaceTask; raw: string; error?: string }> {
  const args = ['status', jobId];
  if (config.okx.aspAgentId) args.push('--agent-id', config.okx.aspAgentId);
  const res = await cli<Record<string, unknown>>(args);
  if (!res.ok) return { ok: false, raw: res.raw, error: res.error };
  const d = res.data ?? {};
  const counterpartyAgentId = extractCounterpartyAgentId(d);
  const task: MarketplaceTask = {
    jobId: String(d.jobId ?? jobId),
    title: String(d.title ?? ''),
    statusCode: Number(d.statusCode ?? -1),
    status: d.status ? String(d.status) : undefined,
    tokenAmount: d.tokenAmount ? String(d.tokenAmount) : undefined,
    tokenSymbol: d.tokenSymbol ? String(d.tokenSymbol) : undefined,
    counterpartyAgentId,
    myAgentId: d.myAgentId ? String(d.myAgentId) : undefined,
    description: d.description ? String(d.description) : undefined,
    designated: true,
  };
  return { ok: true, task, raw: res.raw };
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
   * submitted copy in the local deliverables manifest, and the [intent:deliver]
   * message (with encrypted file envelope or inline text) was sent and verified in XMTP stream.
   */
  contentVerified: boolean;
  error?: string;
}

/**
 * Submit the deliverable. Only valid while the task is `accepted`.
 *
 * `agent deliver` submits on-chain. Immediately after calling deliver(), this
 * ALSO uploads the deliverable file attachment via `uploadFileDeliverable` to get
 * the full encrypted file envelope (fileKey, digest, salt, nonce, secret) or text intent,
 * sends the XMTP `[intent:deliver]` message to the buyer communication address, and confirms
 * broadcast receipt in XMTP session history.
 */
export async function deliverTask(
  jobId: string,
  opts: { file: string; message: string; toAgentId?: string; content?: string },
): Promise<DeliverOutcome> {
  if (!config.okx.aspAgentId) return { submitted: false, contentVerified: false, error: 'OKX_ASP_AGENT_ID not set' };

  let toAgentId = opts.toAgentId;
  if (!toAgentId) {
    const detail = await taskDetail(jobId);
    if (detail.ok && detail.task?.counterpartyAgentId) {
      toAgentId = detail.task.counterpartyAgentId;
    }
  }

  // ── BEFORE the one-way submit, register a backend-visible deliverable ─────
  // Two things must happen while the task is still `accepted`, because the
  // `deliver` below flips it to `submitted` and both become impossible after:
  //   1. task-attach — puts the file in the buyer's `list-attachments`, the
  //      one delivery path that does not depend on the buyer's AI-dispatch.
  //   2. file-upload — encrypts the file and returns the envelope the
  //      `[intent:deliver]` message carries. Done here so an upload failure is
  //      known before we burn the irreversible submit.
  // Hand the CLIs a DISPOSABLE COPY, never our canonical artifact. Verified in
  // production: after a delivery the original .md was gone from
  // $DATA_DIR/deliverables — the tooling consumes the file it is given. That
  // destroys the dispute evidence we are supposed to retain and leaves the
  // repair path unable to re-send as a file.
  let cliFile = opts.file;
  if (opts.file) {
    try {
      const tmp = join(tmpdir(), `legwork-deliver-${jobId.slice(0, 18)}-${Date.now()}.md`);
      await copyFile(opts.file, tmp);
      cliFile = tmp;
    } catch (err) {
      console.warn(`[okx-marketplace] ${jobId}: could not copy the deliverable (${String(err)}) — passing the original.`);
    }
  }

  let fileMeta: FileDeliverMeta | undefined;
  if (opts.file) {
    const attachRes = await attachDeliverable(jobId, cliFile);
    if (attachRes.ok) console.log(`[okx-marketplace] ${jobId}: attached deliverable to task (buyer-queryable in list-attachments).`);
    else console.warn(`[okx-marketplace] ${jobId}: task-attach notice (${attachRes.error}) — relying on the XMTP intent message.`);

    const uploadRes = await uploadFileDeliverable(cliFile, jobId);
    if (uploadRes.ok && uploadRes.data) {
      fileMeta = uploadRes.data;
      console.log(`[okx-marketplace] ${jobId}: uploaded encrypted file envelope key=${fileMeta.fileKey}`);
    } else if (uploadRes.error) {
      console.warn(`[okx-marketplace] ${jobId}: file upload failed (${uploadRes.error}) — the intent message will carry inline text instead.`);
    }
  }

  const res = await cli<unknown>([
    'deliver', jobId,
    // A real file, not `--deliverable-text`: the CLI converts any text over
    // 200 chars into a temp .md anyway, and an explicit path gives us a stable
    // filename plus a local artifact to fall back on and to keep as evidence.
    '--file', cliFile,
    '--message', opts.message,
    '--agent-id', config.okx.aspAgentId,
  ]);
  if (!res.ok) {
    audit('okx-marketplace', 'DELIVER_FAILED', `job=${jobId} ${res.error ?? ''}`.trim());
    return { submitted: false, contentVerified: false, error: res.error };
  }

  console.log(`[okx-marketplace] ${jobId}: on-chain submit landed.`);

  // ── AFTER submit, send the [intent:deliver] message the buyer awaits ───────
  // The buyer receives job_submitted on-chain and then waits for this XMTP
  // message (file envelope, or inline text between - - -) to actually read the
  // work. Sent via `session send`, which reports real delivery — unlike
  // fire-and-forget xmtp-send, whose queued "ok" hid a 100% failure rate.
  let contentVerified = false;
  if (toAgentId) {
    const deliverContent = opts.content ?? opts.message;
    let sendRes = await resendDeliverable(jobId, toAgentId, deliverContent, fileMeta);
    let broadcastOk = sendRes.ok && (await a2aDeliveryMessageBroadcast(jobId, toAgentId));

    if (!broadcastOk) {
      console.warn(`[okx-marketplace] ${jobId}: deliver message not confirmed (sendOk=${sendRes.ok}) — retrying once.`);
      sendRes = await resendDeliverable(jobId, toAgentId, deliverContent, fileMeta);
      broadcastOk = sendRes.ok && (await a2aDeliveryMessageBroadcast(jobId, toAgentId));
    }

    // Buyer-visible via EITHER the backend attachment OR the confirmed intent
    // message. The local manifest (deliverableRetrievable) is ours, not proof
    // the buyer can see it — so it is not part of this verdict.
    contentVerified = broadcastOk;

    console.log(`[okx-marketplace] ${jobId}: deliver message to ${toAgentId}: sendOk=${sendRes.ok}, broadcastConfirmed=${broadcastOk}, type=${fileMeta ? 'file' : 'text'}`);
    audit(
      'okx-marketplace',
      contentVerified ? 'DELIVERED_ONCHAIN' : 'DELIVERED_EMPTY',
      `job=${jobId} to=${toAgentId} type=${fileMeta ? 'file' : 'text'} sendOk=${sendRes.ok} broadcastOk=${broadcastOk}`,
    );
  } else {
    console.error(`[okx-marketplace] ${jobId}: on-chain submit landed BUT no buyer agent id — cannot send the XMTP deliver message.`);
    audit('okx-marketplace', 'DELIVERED_UNROUTABLE', `job=${jobId}`);
  }

  return { submitted: true, contentVerified };
}

/**
 * Attach the deliverable file to the task so it lands in the buyer's
 * backend-queryable `list-attachments`.
 *
 * This is the delivery path that does NOT depend on the buyer's agent
 * processing an XMTP `[intent:deliver]` through a local AI CLI (which fails
 * with "No supported AI CLI found" on their side exactly as it does on ours).
 * The attachment is registered on the backend, so the buyer sees it directly.
 *
 * HARD CONSTRAINT: only valid while the task is `created` or `accepted`. Once
 * the on-chain `deliver` flips it to `submitted`, attachment is refused — so
 * this MUST run before the submit, which is why delivery attaches first.
 */
export async function attachDeliverable(jobId: string, filePath: string): Promise<{ ok: boolean; error?: string }> {
  const res = await cli<unknown>(['task-attach', '--file', filePath, jobId]);
  audit('okx-marketplace', res.ok ? 'DELIVERABLE_ATTACHED' : 'DELIVERABLE_ATTACH_FAILED', `job=${jobId} ${res.error ?? ''}`.trim());
  return { ok: res.ok, error: res.error };
}

/**
 * Has an [intent:deliver] message for this job reached the XMTP session stream?
 *
 * Polled, not sampled once: the daemon persists sends asynchronously, so an
 * immediate read races the write and returns a false negative — which is what
 * logged DELIVERED_EMPTY for deliveries whose message had in fact published.
 */
export async function a2aDeliveryMessageBroadcast(jobId: string, toAgentId?: string, tries = 4): Promise<boolean> {
  if (!toAgentId) return false;
  const delayMs = Number(process.env.OKX_BROADCAST_POLL_MS ?? 2000);
  for (let i = 0; i < tries; i++) {
    const hist = await chatHistory(jobId, toAgentId);
    if (hist.ok && hist.messages.some((m) => m.content.includes('[intent:deliver]') && m.content.includes(jobId))) {
      return true;
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

/**
 * Is the payload recorded in OUR local deliverables manifest?
 *
 * This is a local ledger (`~/.onchainos/deliverables/<role>/<jobId>/`), not a
 * window into the buyer's inbox. Treat it as "we still hold the artifact and
 * can re-send it", never as "the buyer received it".
 */
export async function deliverableRetrievable(jobId: string): Promise<boolean> {
  const res = await cli<{ deliverables?: unknown[]; results?: unknown[] }>([
    'task-deliverable-list', '--job-id', jobId, '--role', 'asp',
  ]);
  if (!res.ok) return false;
  return countDeliverables(res.data) > 0;
}

/** Length of whichever array shape this CLI version returned. */
export function countDeliverables(data: { deliverables?: unknown[]; results?: unknown[] } | undefined): number {
  return (data?.deliverables?.length ?? 0) || (data?.results?.length ?? 0);
}

export interface FileDeliverMeta {
  fileKey: string;
  digest: string;
  salt: string;
  nonce: string;
  secret: string;
  filename?: string;
  mimeType?: string;
}

/**
 * Upload a deliverable file attachment via `okx-a2a file upload`.
 * Returns encryption metadata needed for the file deliver intent.
 */
export async function uploadFileDeliverable(
  filePath: string,
  jobId: string,
): Promise<{ ok: boolean; data?: FileDeliverMeta; error?: string }> {
  if (!config.okx.aspAgentId) return { ok: false, error: 'OKX_ASP_AGENT_ID not set' };
  const res = await a2a([
    'file', 'upload',
    '--file-path', filePath,
    '--agent-id', config.okx.aspAgentId,
    '--job-id', jobId,
    '--json',
  ], 60_000);
  if (!res.ok) return { ok: false, error: res.error };
  try {
    const parsed = JSON.parse(res.raw.slice(res.raw.indexOf('{'))) as FileDeliverMeta;
    if (parsed.fileKey && parsed.digest && parsed.salt && parsed.nonce && parsed.secret) {
      return { ok: true, data: parsed };
    }
    return { ok: false, error: 'missing required encryption fields in file upload result' };
  } catch (err) {
    return { ok: false, error: `failed to parse upload result: ${String(err)}` };
  }
}

/**
 * The `[intent:deliver]` file payload format for A2A message delivery.
 */
export function fileDeliverIntent(jobId: string, meta: FileDeliverMeta): string {
  const lines = [
    '[intent:deliver]',
    `jobId: ${jobId}`,
    'deliverableType: file',
    `fileKey: ${meta.fileKey}`,
    `digest: ${meta.digest}`,
    `salt: ${meta.salt}`,
    `nonce: ${meta.nonce}`,
    `secret: ${meta.secret}`,
  ];
  if (meta.filename) {
    lines.push(`filename: ${meta.filename}`);
  }
  return lines.join('\n');
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
  fileMeta?: FileDeliverMeta,
): Promise<{ ok: boolean; error?: string }> {
  // Same precondition as every outbound path: without the local session the
  // daemon rejects the queued send after the CLI has already said ok.
  const session = await ensureSession(jobId, toAgentId);
  if (!session.ok) {
    audit('okx-marketplace', 'DELIVERABLE_RESEND_FAILED', `job=${jobId} no-session ${session.error ?? ''}`.trim());
    return { ok: false, error: `no XMTP session: ${session.error}` };
  }
  const message = fileMeta
    ? fileDeliverIntent(jobId, fileMeta)
    : content.startsWith('[intent:deliver]')
    ? content
    : textDeliverIntent(jobId, content);

  // `xmtp-send` with the session precondition above — NOT `session send`.
  // Verified from the daemon log (commit 19900c4): `session send` hands the
  // message to the LOCAL AI dispatcher ("No supported AI CLI found"), never to
  // the counterparty. `xmtp-send` is what logs `outbound message-eligible …
  // xmtp-send command completed` and actually reaches the buyer's group. Its
  // queued "ok" is not proof of receipt, which is why the caller confirms the
  // message via a2aDeliveryMessageBroadcast rather than trusting this result.
  const res = await a2a([
    'xmtp-send',
    '--job-id', jobId,
    '--to-agent-id', toAgentId,
    '--message', message,
    '--json',
  ]);
  audit('okx-marketplace', res.ok ? 'DELIVERABLE_RESENT' : 'DELIVERABLE_RESEND_FAILED', `job=${jobId} ${res.error ?? ''}`.trim());
  return res;
}

/**
 * Establish the local XMTP session for a job+counterparty.
 *
 * WITHOUT THIS EVERY OUTBOUND MESSAGE SILENTLY FAILS. The daemon resolves our
 * local XMTP address from a session keyed `job:<id>:my:<us>:to:<them>`; with no
 * session it rejects the queued command with "Cannot infer local XMTP address"
 * — and because sends are queued asynchronously, the CLI has already returned
 * success by then. Production ran with zero sessions and a 0% delivery rate
 * while every call reported ok: the buyer's criteria request, the nudge, and
 * the `[intent:deliver]` carrying the actual shortlist all died in the queue.
 * `contact-user` opens the group on the backend but does not create this local
 * mapping.
 *
 * Idempotent, and cheap enough to run before every send rather than tracking
 * whether we have done it — the daemon's state does not survive a redeploy,
 * and a missing session is invisible until a buyer reports silence.
 */
export async function ensureSession(jobId: string, toAgentId: string): Promise<{ ok: boolean; error?: string }> {
  if (!config.okx.aspAgentId) return { ok: false, error: 'OKX_ASP_AGENT_ID not set' };
  const found = await a2a(['session', 'find', '--job-id', jobId, '--to-agent-id', toAgentId, '--json'], 20_000);
  if (found.ok && /sessionKey/.test(found.raw)) return { ok: true };

  const created = await a2a([
    'session', 'create',
    '--job-id', jobId,
    '--my-agent-id', config.okx.aspAgentId,
    '--to-agent-id', toAgentId,
    '--json',
  ], 30_000);
  audit('okx-marketplace', created.ok ? 'XMTP_SESSION_CREATED' : 'XMTP_SESSION_FAILED', `job=${jobId} to=${toAgentId} ${created.error ?? ''}`.trim());
  return { ok: created.ok, error: created.error };
}

/** One decoded chat message from the task's XMTP group. */
export interface BuyerChatMessage {
  id: string;
  fromAgentId: string;
  content: string;
  sentAt: string;
}

/**
 * Read the task's XMTP chat history from the daemon's session store.
 *
 * This is how the buyer's words actually reach us. Inbound XMTP chat is
 * consumed by the DAEMON, which tries to hand it to a local AI CLI
 * (`ai-dispatch … failed: No supported AI CLI found`) — it never reaches our
 * HTTP endpoint, whose brief capture only ever sees what OKX's backend pushes.
 * A live buyer restated their criteria twice, adding "in case they didn't
 * reach your scanner" — they hadn't. The history entries wrap each message's
 * envelope as a JSON string in `content`; the text lives at `.content` inside
 * it and the author at `.sender.agentId`.
 */
export async function chatHistory(jobId: string, toAgentId: string): Promise<{ ok: boolean; messages: BuyerChatMessage[]; error?: string }> {
  const res = await a2a(['session', 'history', '--job-id', jobId, '--toAgentId', toAgentId, '--limit', '50', '--json'], 30_000);
  if (!res.ok) return { ok: false, messages: [], error: res.error };
  try {
    const parsed = JSON.parse(res.raw.slice(res.raw.indexOf('[') === 0 ? 0 : res.raw.indexOf('{'))) as
      | Array<Record<string, unknown>>
      | { messages?: Array<Record<string, unknown>>; history?: Array<Record<string, unknown>>; list?: Array<Record<string, unknown>> };
    const rows = Array.isArray(parsed) ? parsed : parsed.messages ?? parsed.history ?? parsed.list ?? [];
    const messages: BuyerChatMessage[] = [];
    for (const row of rows) {
      try {
        const envelope = JSON.parse(String(row.content ?? '{}')) as {
          content?: string;
          sender?: { agentId?: string };
        };
        if (!envelope.content) continue;
        messages.push({
          id: String(row.id ?? ''),
          fromAgentId: String(envelope.sender?.agentId ?? ''),
          content: envelope.content,
          sentAt: String(row.sentAt ?? ''),
        });
      } catch {
        // Non-JSON content (plain text row) — keep it, attributed to unknown.
        if (row.content) messages.push({ id: String(row.id ?? ''), fromAgentId: '', content: String(row.content), sentAt: String(row.sentAt ?? '') });
      }
    }
    return { ok: true, messages };
  } catch (err) {
    return { ok: false, messages: [], error: `history parse failed: ${String(err)}` };
  }
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
  const session = await ensureSession(jobId, toAgentId);
  if (!session.ok) {
    audit('okx-marketplace', 'BUYER_CHAT_FAILED', `job=${jobId} no-session ${session.error ?? ''}`.trim());
    return { ok: false, error: `no XMTP session: ${session.error}` };
  }
  // `xmtp-send` IS the outbound path — verified live: with the session in
  // place the daemon logs `outbound message-eligible … xmtp-send command
  // completed` and the message reaches the buyer's group. (`session send`
  // looks like the obvious upgrade but routes to the LOCAL AI dispatcher, not
  // the counterparty — tested, it dies with "No supported AI CLI found".)
  // The command is still queued, so ensureSession above is what makes the ok
  // meaningful: with a session the queue's only failure modes are transport
  // errors the daemon retries itself.
  const res = await a2a([
    'xmtp-send',
    '--job-id', jobId,
    '--to-agent-id', toAgentId,
    '--message', message,
    '--json',
  ], 60_000);
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
