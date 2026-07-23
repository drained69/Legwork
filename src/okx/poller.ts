import { randomBytes } from 'node:crypto';
import type { Bot } from 'grammy';
import { config } from '../config.js';
import { audit, getEngagementByJob, now, saveEngagement, savePayment, uid } from '../db.js';
import {
  EXTRACTABLE_SKILLS,
  KNOWN_CITIES,
  criteriaFromBrief,
  formatShortlist,
  runAdhocHunt,
  type HuntCriteria,
} from '../skills/jobHunt.js';
import { criteriaToProfile } from '../skills/jobHunt.js';
import type { Engagement } from '../types.js';
import { payloadChannelReady, repairDeliverable, submitDeliverable } from './delivery.js';
import {
  TERMINAL_STATUSES,
  TaskStatus,
  a2aDaemonUp,
  activeTasks,
  applyForTask,
  chatToBuyer,
  cliAvailable,
  contactUser,
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
      // Re-sample the chat channel on the same cadence. Sampling it only at
      // startup meant a daemon that recovered stayed "down" for the process
      // lifetime, permanently suppressing buyer greetings and cold-start.
      const up = await a2aDaemonUp().catch(() => commsReady);
      if (up !== commsReady) {
        commsReady = up;
        console.log(`[okx-poller] A2A chat is now ${up ? 'available — greetings and cold-start resumed' : 'unavailable — claiming continues without greetings'}.`);
      }
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
      // `submitted` means the tx landed — NOT that the buyer received anything.
      // Until the payload is confirmed retrievable this task is an empty
      // submission counting down to rejection, so keep repairing it.
      if (!engagement.deliverableSentAt) {
        if (!engagement.shortlist) {
          console.error(`[okx-poller] ${task.jobId}: submitted with no local payload to re-send — buyer has nothing to review.`);
          return;
        }
        const repair = await repairDeliverable(engagement, composeDeliverable(engagement, engagement.shortlist));
        if (repair.ok) {
          await notify(deps, engagement, `📤 Re-sent the deliverable for "${task.title}" — the first submission reached the chain without its payload.`);
        }
      }
      return;

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
      return engagement.deliveredAt ? 'nothing (already delivered)' : 'check xmtp + run hunt + deliver + verify payload';
    case TaskStatus.SUBMITTED:
      return engagement.deliverableSentAt
        ? 'nothing (awaiting buyer review)'
        : 're-send deliverable over XMTP (submitted without a retrievable payload)';
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
 *
 * Order matters and is not negotiable: the payload is produced, written to
 * disk, and the payload channel confirmed up BEFORE anything touches the
 * chain. Submitting first is what produces an empty submission — the buyer
 * sees `submitted`, finds nothing to review, and rejects.
 */
async function fulfil(task: MarketplaceTask, engagement: Engagement, deps: PollerDeps): Promise<void> {
  // Cheap early-out before the hunt spends API quota and LLM calls on work we
  // would only have to hold. `submitDeliverable` re-checks immediately before
  // the submit — that one is authoritative, this one just avoids the waste.
  if (!(await payloadChannelReady(task.jobId))) return;

  // `||` not `??`: an empty-string brief is as useless as a missing one, and
  // `engagement.brief ?? task.description` would have kept `''`.
  const brief = (engagement.brief || task.description || '').trim();

  // Refuse to guess. The marketplace gives us a title and a budget — there is
  // no description field on `active-tasks` or `agent status` — so without the
  // buyer's chat brief we have no salary floor, no skills and no locations,
  // and the hunt degenerates into a title-keyword search that returns nothing.
  // Delivering that burns the task: `submitted` is one-way, and an unusable
  // shortlist is rejected with the escrow unfunded. Asking costs one message.
  if (!briefIsUsable(brief)) {
    await requestCriteria(task, engagement);
    return;
  }

  const criteria = await criteriaFromBrief(task.title, brief);
  const result = await runAdhocHunt(criteria);

  // Never submit an empty shortlist. "top 0 of 0 postings" is not a
  // deliverable — it is a rejection with extra steps. Hold the task in
  // `accepted` (still deliverable) and retry on the next tick, telling the
  // buyer what we searched so they can correct it.
  if (!result.matches.length) {
    await handleNoMatches(task, engagement, criteria, result.found, deps);
    return;
  }

  const shortlist = formatShortlist(
    criteriaToProfile(criteria, engagement.id),
    result.matches,
    result.found,
    true,
  );
  // Persist the work before attempting delivery: if the submit is held or the
  // process dies, the shortlist survives and the repair path can re-send it
  // rather than re-running the whole hunt.
  engagement.shortlist = shortlist;
  saveEngagement(engagement);

  const summary =
    `Legwork shortlist — ${result.matches.length} ranked matches from ${result.found} postings, ` +
    'each with a full score breakdown. Full report attached.';

  const res = await submitDeliverable(engagement, composeDeliverable(engagement, shortlist), summary);

  if (!res.submitted) {
    // Nothing went on-chain, so the task is still `accepted` and the next tick
    // retries the whole thing cleanly.
    console.error(`[okx-poller] deliver failed for ${task.jobId}: ${res.error}`);
    return;
  }
  if (!res.ok) {
    console.error(`[okx-poller] ${task.jobId}: submitted without a retrievable payload — will keep repairing: ${res.error}`);
    return; // the SUBMITTED branch retries the repair every tick
  }

  console.log(`[okx-poller] delivered ${task.jobId} — ${result.matches.length} matches from ${result.found} postings`);
  await notify(
    deps,
    engagement,
    res.repaired
      ? `📤 Delivered your OKX task "${task.title}" — ${result.matches.length} ranked matches (payload re-sent after a partial submit).`
      : `🏁 Delivered your OKX task "${task.title}" — ${result.matches.length} ranked matches submitted for acceptance.`,
  );
}

/**
 * Is there enough here to hunt against?
 *
 * A title alone is not a brief. "Job hunt shortlist help" yields no salary
 * floor, no skills and no locations, and searching a job board for that phrase
 * returns nothing — which is how an empty shortlist gets built and shipped.
 * Require at least one concrete signal a buyer would recognise as their ask.
 */
export function briefIsUsable(brief: string): boolean {
  const text = brief.toLowerCase();
  if (text.length < 25) return false;
  const hasComp = /\$\s*\d|\d{2,3}\s*k\b|\d{5,7}/.test(text);
  const hasSkill = EXTRACTABLE_SKILLS.some((s) => text.includes(s));
  const hasPlace = /\bremote\b|\bhybrid\b|\bonsite\b/.test(text) || KNOWN_CITIES.some((c) => text.includes(c));
  const hasRole = /\bengineer|developer|designer|manager|analyst|scientist|architect|writer|marketer\b/.test(text);
  // Two independent signals: one alone is as likely to be a stray word.
  return [hasComp, hasSkill, hasPlace, hasRole].filter(Boolean).length >= 2;
}

/**
 * Ask the buyer for the requirements the marketplace never gave us.
 *
 * Sent at most once per engagement — a bot that repeats itself every 30s is
 * worse than one that waits. The task stays `accepted` and deliverable, so a
 * reply on any later tick resumes the hunt with real criteria.
 */
async function requestCriteria(task: MarketplaceTask, engagement: Engagement): Promise<void> {
  if (engagement.criteriaRequestedAt) return;
  if (!engagement.okxBuyerAgentId) {
    console.error(`[okx-poller] ${task.jobId}: brief is unusable and no buyer agent id to ask — holding.`);
    return;
  }
  const res = await chatToBuyer(
    task.jobId,
    engagement.okxBuyerAgentId,
    'Before I run the hunt I need your criteria, so the shortlist is scored against what you actually want ' +
      'rather than guessed from the task title. Please reply with:\n' +
      '• Target roles (e.g. senior backend engineer)\n' +
      '• Must-have skills (e.g. Python, Go, Postgres, AWS)\n' +
      '• Minimum base salary (e.g. $140k)\n' +
      '• Locations, including whether remote works (e.g. remote-US, Austin, Denver)\n\n' +
      'I will start as soon as that arrives and deliver the ranked shortlist to this task.',
  );
  if (!res.ok) {
    console.error(`[okx-poller] ${task.jobId}: could not ask the buyer for criteria: ${res.error}`);
    return;
  }
  engagement.criteriaRequestedAt = now();
  saveEngagement(engagement);
  audit('okx-poller', 'CRITERIA_REQUESTED', `job=${task.jobId}`);
  console.log(`[okx-poller] ${task.jobId}: brief unusable — asked the buyer for criteria, holding the task.`);
}

/**
 * The hunt ran but matched nothing.
 *
 * Do NOT submit. An empty shortlist reads as no work done, and submitting is
 * irreversible. Tell the buyer what was searched — the criteria are the thing
 * they can correct — and leave the task deliverable for the next tick.
 */
async function handleNoMatches(
  task: MarketplaceTask,
  engagement: Engagement,
  criteria: HuntCriteria,
  scanned: number,
  deps: PollerDeps,
): Promise<void> {
  console.warn(`[okx-poller] ${task.jobId}: 0 matches from ${scanned} postings — withholding delivery.`);
  audit('okx-poller', 'EMPTY_HUNT_WITHHELD', `job=${task.jobId} scanned=${scanned}`);

  if (engagement.okxBuyerAgentId && !engagement.noMatchNoticeAt) {
    await chatToBuyer(
      task.jobId,
      engagement.okxBuyerAgentId,
      `No postings matched yet, so I am holding the shortlist rather than delivering an empty one.\n\n` +
        `Searched for: ${describeCriteria(criteria)}\n` +
        `Scanned this pass: ${scanned} postings.\n\n` +
        'I keep scanning as new listings appear. If any of the above is wrong — especially the salary floor or ' +
        'the locations — reply with a correction and I will re-run immediately.',
    );
    engagement.noMatchNoticeAt = now();
    saveEngagement(engagement);
  }

  await notify(
    deps,
    engagement,
    `⏸ "${task.title}" — 0 of ${scanned} postings matched. Holding delivery rather than submitting an empty shortlist.`,
  );
}

/** Human-readable echo of what we actually searched for. */
export function describeCriteria(c: HuntCriteria): string {
  const parts = [
    (c.roles ?? []).length ? (c.roles ?? []).join(' / ') : 'any role',
    c.seniority ?? 'any level',
    (c.locations ?? []).length ? (c.locations ?? []).join(', ') : 'any location',
    c.compFloor ? `$${Number(c.compFloor).toLocaleString()}+ base` : 'no salary floor',
  ];
  if ((c.skills ?? []).length) parts.push(`skills: ${(c.skills ?? []).join(', ')}`);
  return parts.join(' · ');
}

/**
 * The exact bytes the buyer is owed: the shortlist plus the thread that turns
 * it into applications. Rebuilt rather than stored so a repair re-sends the
 * same payload the original delivery carried.
 */
function composeDeliverable(engagement: Engagement, shortlist: string): string {
  const deepLink = `https://t.me/${config.telegram.username}?start=${engagement.taskCode}`;
  // The Telegram link is an OPTIONAL footer, not the deliverable. A buyer who
  // paid for a shortlist and received a redirect to an external bot reasonably
  // reads that as no work delivered, so the listings lead and the link is
  // clearly marked as extra.
  return (
    `${shortlist}\n\n` +
    `— Optional: continue in a private thread to refine criteria, get tailored drafts and approve applications: ${deepLink}\n` +
    '  (Not required — the ranked shortlist above is the complete deliverable.)'
  );
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
