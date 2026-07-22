import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { audit, now, saveEngagement } from '../db.js';
import type { Engagement } from '../types.js';
import {
  a2aDaemonUp,
  deliverTask,
  deliverableRetrievable,
  resendDeliverable,
  startA2aDaemon,
} from './marketplace.js';

/**
 * Deliverable transmission — the one place that decides a buyer has the goods.
 *
 * Submitting on-chain and transmitting the payload are two legs that fail
 * independently. `onchainos agent deliver` hides both behind a single exit
 * code: it uploads the file, xmtp-sends `[intent:deliver]` to the buyer,
 * submits on-chain, and saves locally. When the XMTP daemon is down the submit
 * still lands, so the task reaches `submitted` carrying nothing — the buyer
 * polls `task-deliverable-list`, finds it empty, and rejects an empty
 * submission. Escrow is never funded and the rating is spent for nothing.
 *
 * The rules that follow from that, enforced here rather than at each call site:
 *   1. Never submit while the payload channel is down — the submit window is
 *      one-way. A held deliverable can still be sent; a submitted empty one
 *      cannot be un-submitted.
 *   2. A zero exit code is not delivery. Verify the payload is retrievable.
 *   3. If the submit landed without a payload, repair over XMTP — `deliver` is
 *      refused once the task leaves `accepted`, so re-sending is the only path.
 */

export interface DeliveryResult {
  /** The buyer can retrieve the payload — verified against the backend. */
  ok: boolean;
  /** The submit tx landed. The task has left `accepted` for good. */
  submitted: boolean;
  /** Set when the payload had to be re-sent after a partial delivery. */
  repaired?: boolean;
  error?: string;
}

/**
 * Produce, submit, and confirm a deliverable.
 *
 * `deliverable` must be the finished payload — this does no work of its own,
 * because the work has to exist before anything touches the chain.
 */
export async function submitDeliverable(
  engagement: Engagement,
  deliverable: string,
  summary: string,
): Promise<DeliveryResult> {
  const jobId = engagement.okxJobId;

  if (!(await payloadChannelReady(jobId))) {
    return { ok: false, submitted: false, error: 'XMTP channel down — deliverable held' };
  }

  const file = await writeDeliverable(jobId, deliverable);
  engagement.deliverableFile = file;
  engagement.status = 'delivering';
  saveEngagement(engagement);

  const res = await deliverTask(jobId, { file, message: summary });
  if (!res.submitted) {
    // Nothing went on-chain, so the task is still `accepted` and the caller can
    // retry the whole thing cleanly on the next pass.
    return { ok: false, submitted: false, error: res.error };
  }

  engagement.deliveredAt = now();
  saveEngagement(engagement);

  if (res.contentVerified) {
    engagement.deliverableSentAt = engagement.deliveredAt;
    saveEngagement(engagement);
    return { ok: true, submitted: true };
  }

  console.error(`[okx-delivery] ${jobId}: submit landed but the deliverable is not retrievable — repairing over XMTP.`);
  const repair = await repairDeliverable(engagement, deliverable);
  return { ...repair, submitted: true, repaired: repair.ok };
}

/**
 * Get the payload to a buyer whose task is already `submitted`.
 *
 * Safe to call on every pass: it re-checks retrievability first, so a payload
 * that landed late (CLI retry, daemon recovery) closes the loop without
 * sending a duplicate.
 */
export async function repairDeliverable(engagement: Engagement, deliverable: string): Promise<DeliveryResult> {
  const jobId = engagement.okxJobId;

  if (await deliverableRetrievable(jobId)) {
    engagement.deliverableSentAt = now();
    saveEngagement(engagement);
    audit('okx-delivery', 'DELIVERABLE_CONFIRMED', `job=${jobId}`);
    return { ok: true, submitted: true };
  }
  if (!(await payloadChannelReady(jobId))) {
    return { ok: false, submitted: true, error: 'XMTP channel down — cannot re-send' };
  }
  if (!engagement.okxBuyerAgentId) {
    const error = 'no buyer agent id on the engagement — cannot address the re-send';
    console.error(`[okx-delivery] ${jobId}: ${error}`);
    audit('okx-delivery', 'DELIVERABLE_UNROUTABLE', `job=${jobId}`);
    return { ok: false, submitted: true, error };
  }

  const res = await resendDeliverable(jobId, engagement.okxBuyerAgentId, deliverable);
  if (!res.ok) {
    console.error(`[okx-delivery] ${jobId}: deliverable re-send failed: ${res.error}`);
    return { ok: false, submitted: true, error: res.error };
  }

  engagement.deliverableSentAt = now();
  saveEngagement(engagement);
  console.log(`[okx-delivery] ${jobId}: deliverable re-sent to buyer agent ${engagement.okxBuyerAgentId}`);
  return { ok: true, submitted: true, repaired: true };
}

/**
 * Is the XMTP channel up, restarting the daemon once if not?
 *
 * The daemon is ours and `daemon start` is idempotent, so one restart attempt
 * is cheaper than losing the task. Exactly one: if it does not come back the
 * deliverable waits for the next pass rather than looping.
 */
export async function payloadChannelReady(jobId: string): Promise<boolean> {
  if (await a2aDaemonUp()) return true;

  console.warn(`[okx-delivery] ${jobId}: XMTP daemon is down — restarting before delivering.`);
  await startA2aDaemon();
  if (await a2aDaemonUp()) return true;

  console.error(
    `[okx-delivery] ${jobId}: XMTP daemon still down — holding the deliverable rather than submitting an empty task. ` +
      'Fix with `okx-a2a doctor --fix`.',
  );
  audit('okx-delivery', 'DELIVERY_HELD', `job=${jobId} reason=xmtp-down`);
  return false;
}

/**
 * Persist the deliverable as a real .md file.
 *
 * A file rather than `--deliverable-text` because the CLI converts any text
 * over 200 chars into a temp .md anyway, and an explicit path gives a stable
 * filename plus an artifact to re-send from. Kept out of the OS temp dir: it
 * is dispute evidence and must outlive a reboot.
 */
export async function writeDeliverable(jobId: string, content: string): Promise<string> {
  const dir = join(config.dataDir, 'deliverables');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `legwork-shortlist-${jobId.slice(0, 18)}.md`);
  await writeFile(file, content, 'utf8');
  return file;
}
