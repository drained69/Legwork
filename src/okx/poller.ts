import { randomBytes } from 'node:crypto';
import type { Bot } from 'grammy';
import { config } from '../config.js';
import { audit, getEngagementByJob, now, saveEngagement, savePayment, uid } from '../db.js';
import { criteriaFromBrief, formatShortlist, runAdhocHunt } from '../skills/jobHunt.js';
import { criteriaToProfile } from '../skills/jobHunt.js';
import type { Engagement } from '../types.js';
import {
  TERMINAL_STATUSES,
  TaskStatus,
  activeTasks,
  applyForTask,
  cliAvailable,
  contactUser,
  deliverTask,
  gateCheck,
  heartbeat,
  recommendedTasks,
  type MarketplaceTask,
} from './marketplace.js';

/**
 * Marketplace poller — the half of the ASP protocol Legwork was missing.
 *
 * OKX does not guarantee a push for every task that names this agent. The
 * provider is expected to PULL the task list and claim what is addressed to
 * it; anything left in `created` is expired by the backend, which the buyer
 * experiences as "the provider agent timed out".
 *
 * Each tick, for every task routed to this agent:
 *   created   → contact the buyer, then apply on-chain (designated tasks only)
 *   accepted  → escrow is funded: run the hunt and deliver
 *   completed → settled; notify the bound Telegram user
 *   terminal  → close the engagement locally
 *
 * The loop is single-flight, never throws, and degrades to a no-op with one
 * clear log line when the CLI or the ASP identity is unavailable.
 */

/** Public tasks worth a cold-start contact — anything else is noise. */
const RELEVANCE = /\b(job|jobs|career|careers|resume|cv|cover letter|hiring|hire|recruit|vacancy|vacancies|application|applicant|employment|interview)\b/i;

/** Cap cold-start outreach per tick so a busy marketplace can't run away. */
const MAX_COLD_START_PER_TICK = 3;

interface PollerDeps {
  bot: Bot | null;
}

let timer: NodeJS.Timeout | undefined;
let running = false;
let consecutiveFailures = 0;
let lastHeartbeat = 0;
/**
 * Is the OKX A2A chat channel up? Set once from gate-check at startup.
 *
 * When it is down we still claim tasks: applying is what stops the expiry
 * clock, and a chat outage must not also cost us the task.
 */
let commsReady = true;

const HEARTBEAT_INTERVAL_MS = 5 * 60_000;

export interface PollerHandle {
  stop: () => void;
  /** Exposed for tests and for the /health endpoint. */
  tick: () => Promise<void>;
}

export async function startMarketplacePoller(deps: PollerDeps): Promise<PollerHandle | null> {
  const noop: PollerHandle = { stop: () => undefined, tick: async () => undefined };

  if (!config.okx.aspAgentId) {
    console.log('[okx-poller] OKX_ASP_AGENT_ID not set — marketplace polling disabled. Tasks addressed to this agent WILL expire unclaimed.');
    return null;
  }
  if (!(await cliAvailable())) {
    console.error('[okx-poller] onchainos CLI not found — marketplace polling disabled. Tasks addressed to this agent WILL expire unclaimed.');
    return null;
  }

  const gate = await gateCheck();
  // Claiming needs the wallet and the ASP identity. It does NOT need chat:
  // `asp-apply` is what stops the expiry clock. OKX's gate-check folds A2A
  // comms into `ready`, but treating that as fatal means a chat outage
  // silently costs us every task — the exact failure this poller exists to
  // prevent. So gate on the two that matter and degrade on the third.
  if (!gate.wallet || !gate.identity) {
    console.error(
      `[okx-poller] gate-check failed (wallet=${gate.wallet} identity=${gate.identity} comms=${gate.communication}` +
        `${gate.error ? ` error=${gate.error}` : ''}) — polling disabled until the service wallet is signed in.`,
    );
    return null;
  }
  commsReady = gate.communication;
  if (!commsReady) {
    console.warn(
      '[okx-poller] A2A chat is unavailable — claiming still runs so tasks do not expire, but the buyer greeting is skipped ' +
        'and negotiation messages will not be delivered. Fix with `okx-a2a doctor --fix`.',
    );
  }
  if (gate.agentId && gate.agentId !== config.okx.aspAgentId) {
    console.warn(`[okx-poller] configured OKX_ASP_AGENT_ID=${config.okx.aspAgentId} but the signed-in identity is ${gate.agentId}.`);
  }

  console.log(
    `[okx-poller] polling every ${config.okx.pollIntervalMs}ms as agent ${config.okx.aspAgentId} ` +
      `(autoApply=${config.okx.autoApply} autoDeliver=${config.okx.autoDeliver})`,
  );

  const tick = () => pollOnce(deps);
  // Claim whatever is already waiting before the first interval elapses.
  void tick();
  timer = setInterval(() => void tick(), config.okx.pollIntervalMs);
  timer.unref?.();

  return { stop: () => timer && clearInterval(timer), tick };
}

/**
 * One poll cycle. Single-flight: a slow CLI call must not stack up ticks,
 * which would double-claim tasks.
 */
export async function pollOnce(deps: PollerDeps): Promise<void> {
  if (running) return;
  running = true;
  try {
    if (Date.now() - lastHeartbeat > HEARTBEAT_INTERVAL_MS) {
      lastHeartbeat = Date.now();
      await heartbeat().catch(() => false);
    }

    const { ok, tasks, error } = await activeTasks();
    if (!ok) {
      consecutiveFailures += 1;
      // Log the first few, then go quiet — a persistent outage must not fill
      // the log, but it must not be silent either.
      if (consecutiveFailures <= 3 || consecutiveFailures % 20 === 0) {
        console.error(`[okx-poller] active-tasks failed (${consecutiveFailures}x): ${error}`);
      }
      return;
    }
    consecutiveFailures = 0;

    for (const task of tasks) {
      try {
        await handleTask(task, deps);
      } catch (err) {
        console.error(`[okx-poller] task ${task.jobId} failed:`, err);
      }
    }

    await coldStartDiscovery();
  } catch (err) {
    console.error('[okx-poller] cycle failed:', err);
  } finally {
    running = false;
  }
}

// ── per-task state machine ─────────────────────────────────────────────────

async function handleTask(task: MarketplaceTask, deps: PollerDeps): Promise<void> {
  const engagement = upsertEngagement(task);

  if (config.okx.dryRun) {
    console.log(
      `[okx-poller][dry-run] ${task.jobId} status=${task.status ?? task.statusCode} "${task.title}" ` +
        `budget=${task.tokenAmount ?? '?'} ${task.tokenSymbol ?? ''} → would ${plannedAction(task, engagement)}`,
    );
    return;
  }

  switch (task.statusCode) {
    case TaskStatus.CREATED:
      await claim(task, engagement, deps);
      return;

    case TaskStatus.ACCEPTED:
      // Escrow is funded. This is the only window in which `deliver` is legal,
      // and it closes — a missed window auto-refunds the buyer.
      if (engagement.status === 'awaiting_link') {
        engagement.status = 'active';
        saveEngagement(engagement);
      }
      if (config.okx.autoDeliver && !engagement.deliveredAt) await fulfil(task, engagement, deps);
      return;

    case TaskStatus.SUBMITTED:
      return; // delivered; waiting on the buyer's review

    case TaskStatus.COMPLETED:
      if (engagement.status !== 'settled') {
        engagement.status = 'settled';
        saveEngagement(engagement);
        savePayment({
          id: uid(), engagementId: engagement.id, okxJobId: task.jobId, kind: 'settle',
          amount: task.tokenAmount, currency: task.tokenSymbol, raw: JSON.stringify(task), at: now(),
        });
        audit('okx-poller', 'SETTLED', `job=${task.jobId}`);
        await notify(deps, engagement, `💰 Buyer accepted delivery on OKX — task "${task.title}" is settled.`);
      }
      return;

    case TaskStatus.REJECTED:
    case TaskStatus.DISPUTED:
      if (engagement.status !== 'disputed') {
        engagement.status = 'disputed';
        saveEngagement(engagement);
        audit('okx-poller', 'CONTESTED', `job=${task.jobId} status=${task.statusCode}`);
        await notify(deps, engagement, `⚠️ The buyer contested delivery on OKX task "${task.title}". The approval log and frozen drafts are preserved as evidence.`);
      }
      return;

    default:
      if (TERMINAL_STATUSES.includes(task.statusCode) && engagement.status !== 'closed') {
        engagement.status = 'closed';
        saveEngagement(engagement);
        audit('okx-poller', 'CLOSED', `job=${task.jobId} status=${task.statusCode}`);
      }
  }
}

/** What a live tick would do with this task — dry-run reporting only. */
function plannedAction(task: MarketplaceTask, engagement: Engagement): string {
  switch (task.statusCode) {
    case TaskStatus.CREATED: {
      const steps: string[] = [];
      if (!engagement.claimedAt) steps.push('contact-user');
      const budget = Number(task.tokenAmount ?? '0');
      if (!engagement.appliedAt && config.okx.autoApply && task.designated) {
        if (budget > 0 && budget <= config.okx.maxAutoApplyBudget) steps.push(`apply ${task.tokenAmount} ${task.tokenSymbol ?? 'USDT'}`);
        else steps.push(`SKIP apply (budget ${budget} outside 0 < b <= ${config.okx.maxAutoApplyBudget})`);
      }
      return steps.join(' + ') || 'nothing (already claimed)';
    }
    case TaskStatus.ACCEPTED:
      return engagement.deliveredAt ? 'nothing (already delivered)' : 'run hunt + deliver';
    case TaskStatus.SUBMITTED:
      return 'nothing (awaiting buyer review)';
    case TaskStatus.COMPLETED:
      return 'mark settled';
    default:
      return 'mark closed/contested locally';
  }
}

/**
 * Claim a task in `created`.
 *
 * Two steps, in order and independently recorded, because they fail
 * independently: opening the chat proves a provider is alive, applying is
 * what actually stops the expiry clock.
 */
async function claim(task: MarketplaceTask, engagement: Engagement, deps: PollerDeps): Promise<void> {
  if (!engagement.claimedAt) {
    if (!commsReady) {
      // No chat channel at all, so the greeting is impossible rather than
      // merely failing. Fall through to apply: an ungreeted buyer is
      // recoverable, an expired task is not. claimedAt stays unset so the
      // greeting is retried if comms come back.
      if (!engagement.appliedAt) {
        console.warn(`[okx-poller] ${task.jobId}: A2A chat down — applying without the buyer greeting so the task does not expire.`);
      }
    } else {
      const contact = await contactUser(task.jobId);
      if (contact.ok) {
        engagement.claimedAt = now();
        saveEngagement(engagement);
        console.log(`[okx-poller] claimed ${task.jobId} — "${task.title}"`);
      } else if (!/already|exists|duplicate/i.test(contact.error ?? '')) {
        console.error(`[okx-poller] contact-user failed for ${task.jobId}: ${contact.error}`);
        return; // retry next tick rather than applying to a buyer we never greeted
      } else {
        engagement.claimedAt = now(); // channel already open from an earlier run
        saveEngagement(engagement);
      }
    }
  }

  if (engagement.appliedAt || !config.okx.autoApply || !task.designated) return;

  const budget = Number(task.tokenAmount ?? '0');
  if (!(budget > 0)) {
    console.warn(`[okx-poller] ${task.jobId} has no budget — leaving it for the buyer to fund.`);
    return;
  }
  if (budget > config.okx.maxAutoApplyBudget) {
    console.warn(`[okx-poller] ${task.jobId} budget ${budget} exceeds OKX_MAX_AUTO_APPLY_BUDGET — skipping auto-apply.`);
    return;
  }

  const res = await applyForTask(task.jobId, String(task.tokenAmount), task.tokenSymbol ?? 'USDT');
  if (res.ok) {
    engagement.appliedAt = now();
    saveEngagement(engagement);
    savePayment({
      id: uid(), engagementId: engagement.id, okxJobId: task.jobId, kind: 'escrow',
      amount: task.tokenAmount, currency: task.tokenSymbol, raw: JSON.stringify(task), at: now(),
    });
    console.log(`[okx-poller] applied to ${task.jobId} at ${task.tokenAmount} ${task.tokenSymbol}`);
  } else if (/already applied|duplicate/i.test(res.error ?? '')) {
    engagement.appliedAt = now();
    saveEngagement(engagement);
  } else {
    console.error(`[okx-poller] apply failed for ${task.jobId}: ${res.error}`);
  }
}

/**
 * Do the work and submit it on-chain.
 *
 * The buyer's brief is the criteria source, so a task can be served end to end
 * without waiting for a Telegram onboarding. The deep link still goes out with
 * the deliverable: the shortlist is the machine half, approvals stay human.
 */
async function fulfil(task: MarketplaceTask, engagement: Engagement, deps: PollerDeps): Promise<void> {
  const brief = engagement.brief ?? task.description ?? '';
  const criteria = await criteriaFromBrief(task.title, brief);
  const result = await runAdhocHunt(criteria);

  const shortlist = formatShortlist(
    criteriaToProfile(criteria, engagement.id),
    result.matches,
    result.found,
    true,
  );
  const deepLink = `https://t.me/${config.telegram.username}?start=${engagement.taskCode}`;
  const deliverable =
    `${shortlist}\n\n` +
    `— Continue in your private thread to refine criteria, get tailored drafts, and approve applications: ${deepLink}`;

  engagement.shortlist = shortlist;
  engagement.status = 'delivering';
  saveEngagement(engagement);

  const res = await deliverTask(task.jobId, deliverable);
  if (!res.ok) {
    console.error(`[okx-poller] deliver failed for ${task.jobId}: ${res.error}`);
    return;
  }
  engagement.deliveredAt = now();
  saveEngagement(engagement);
  console.log(`[okx-poller] delivered ${task.jobId} — ${result.matches.length} matches from ${result.found} postings`);
  await notify(deps, engagement, `🏁 Delivered your OKX task "${task.title}" — ${result.matches.length} ranked matches submitted for acceptance.`);
}

/**
 * Cold-start discovery of PUBLIC tasks nobody has been designated for.
 *
 * Deliberately conservative: contact only, never apply. On a public task the
 * buyer has not chosen us yet, so applying on-chain would be jumping the
 * negotiation the protocol requires.
 */
async function coldStartDiscovery(): Promise<void> {
  // Cold start's only action is opening a chat. With comms down every call
  // would fail, so skip the sweep rather than burn a CLI round-trip per task
  // per tick. Designated tasks still get claimed — see claim().
  if (!commsReady) return;

  const { ok, tasks, error } = await recommendedTasks();
  if (!ok) {
    // Expected while the agent listing is still under review — the backend
    // answers `AgentApi.agentServices failed`. Not worth a per-tick error.
    if (consecutiveFailures === 0 && error && !/agentServices/i.test(error)) {
      console.warn(`[okx-poller] recommend-task unavailable: ${error}`);
    }
    return;
  }

  let contacted = 0;
  for (const task of tasks) {
    if (contacted >= MAX_COLD_START_PER_TICK) break;
    if (getEngagementByJob(task.jobId)) continue; // already tracked
    if (!RELEVANCE.test(`${task.title} ${task.description ?? ''}`)) continue;

    if (config.okx.dryRun) {
      console.log(`[okx-poller][dry-run] public task ${task.jobId} "${task.title}" → would contact-user`);
      continue;
    }

    const engagement = upsertEngagement(task);
    const res = await contactUser(task.jobId);
    if (res.ok) {
      engagement.claimedAt = now();
      saveEngagement(engagement);
      contacted += 1;
      console.log(`[okx-poller] cold-start contact on public task ${task.jobId} — "${task.title}"`);
    }
  }
}

// ── engagement mirror ──────────────────────────────────────────────────────

/**
 * Every marketplace task gets a local engagement so the Telegram side, the
 * digest, and the evidence bundle all keep working unchanged.
 */
function upsertEngagement(task: MarketplaceTask): Engagement {
  const existing = getEngagementByJob(task.jobId);
  if (existing) {
    let changed = false;
    if (existing.okxStatusCode !== task.statusCode) {
      existing.okxStatusCode = task.statusCode;
      changed = true;
    }
    if (task.title && existing.title !== task.title) {
      existing.title = task.title;
      changed = true;
    }
    if (task.description && !existing.brief) {
      existing.brief = task.description;
      changed = true;
    }
    if (changed) saveEngagement(existing);
    return existing;
  }

  const listing = inferListing(task);
  const engagement: Engagement = {
    id: uid(),
    okxJobId: task.jobId,
    okxBuyerAgentId: task.counterpartyAgentId,
    taskCode: randomBytes(6).toString('hex'),
    listing,
    status: 'awaiting_link',
    startedAt: now(),
    endsAt: new Date(Date.now() + listingDays(listing) * 86400_000).toISOString(),
    title: task.title,
    brief: task.description,
    budget: task.tokenAmount,
    currency: task.tokenSymbol,
    okxStatusCode: task.statusCode,
  };
  saveEngagement(engagement);
  audit('okx-poller', 'TASK_DISCOVERED', `job=${task.jobId} status=${task.statusCode} budget=${task.tokenAmount ?? '?'}`);
  return engagement;
}

/** Map the buyer's brief onto a listing so pricing and quotas stay coherent. */
export function inferListing(task: Pick<MarketplaceTask, 'title' | 'description'>): string {
  const text = `${task.title} ${task.description ?? ''}`.toLowerCase();
  if (/\b(resume|cv|cover letter|tailor|application package)\b/.test(text)) return 'tailor-one-application';
  if (/\b(daily|weekly|every day|ongoing|7 days|sprint)\b/.test(text)) return 'job-hunt-weekly';
  return 'job-hunt';
}

function listingDays(listing: string): number {
  return listing === 'job-hunt-weekly' || listing === 'job-search-sprint-7d' ? 7 : 1;
}

async function notify(deps: PollerDeps, engagement: Engagement, text: string): Promise<void> {
  if (!deps.bot || !engagement.userId) return;
  await deps.bot.api.sendMessage(Number(engagement.userId), text).catch(() => {});
}
