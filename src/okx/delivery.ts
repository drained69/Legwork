import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { audit, now, saveEngagement } from '../db.js';
import type { Engagement } from '../types.js';
import {
  a2aDaemonUp,
  a2aDeliveryMessageBroadcast,
  deliverTask,
  deliverableRetrievable,
  ensureSession,
  resendDeliverable,
  startA2aDaemon,
  taskDetail,
  uploadFileDeliverable,
  type FileDeliverMeta,
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
  /**
   * Every leg of the deliver pipeline completed on our side: file persisted to
   * the local deliverables manifest, [intent:deliver] queued over XMTP, submit
   * on-chain. Verified via `task-deliverable-list`, which reads the manifest —
   * the CLI writes it only after the earlier legs succeed. NOT proof the buyer
   * has opened it: XMTP is store-and-forward, and their side of the ledger is
   * theirs. The repair path re-sends the payload for exactly that reason.
   */
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

  if (!engagement.okxBuyerAgentId) {
    const detail = await taskDetail(jobId);
    if (detail.ok && detail.task?.counterpartyAgentId) {
      engagement.okxBuyerAgentId = detail.task.counterpartyAgentId;
      saveEngagement(engagement);
    }
  }

  // Establish local session before the one-way submit so XMTP payload send succeeds.
  if (engagement.okxBuyerAgentId) {
    const session = await ensureSession(jobId, engagement.okxBuyerAgentId);
    if (!session.ok) {
      console.error(`[okx-delivery] ${jobId}: no XMTP session (${session.error}) — holding rather than submitting a payload that cannot reach the buyer.`);
      audit('okx-delivery', 'DELIVERY_HELD', `job=${jobId} reason=no-session`);
      return { ok: false, submitted: false, error: `no XMTP session: ${session.error}` };
    }
  }

  const file = await writeDeliverable(jobId, deliverable);
  engagement.deliverableFile = file;
  engagement.status = 'delivering';
  saveEngagement(engagement);

  const res = await deliverTask(jobId, {
    file,
    message: summary,
    toAgentId: engagement.okxBuyerAgentId,
    content: deliverable,
  });
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

  if (!engagement.okxBuyerAgentId) {
    const detail = await taskDetail(jobId);
    if (detail.ok && detail.task?.counterpartyAgentId) {
      engagement.okxBuyerAgentId = detail.task.counterpartyAgentId;
      saveEngagement(engagement);
    }
  }

  const retrievable = await deliverableRetrievable(jobId);
  const broadcast = await a2aDeliveryMessageBroadcast(jobId, engagement.okxBuyerAgentId);
  if (retrievable && broadcast) {
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

  let fileMeta: FileDeliverMeta | undefined;
  if (engagement.deliverableFile) {
    const uploadRes = await uploadFileDeliverable(engagement.deliverableFile, jobId);
    if (uploadRes.ok) fileMeta = uploadRes.data;
  }

  const res = await resendDeliverable(jobId, engagement.okxBuyerAgentId, deliverable, fileMeta);
  if (!res.ok) {
    console.error(`[okx-delivery] ${jobId}: deliverable re-send failed: ${res.error}`);
    return { ok: false, submitted: true, error: res.error };
  }

  // The re-send returned a queued "ok" — not proof it landed. Confirm the
  // intent actually reached the buyer's session stream before marking it sent,
  // or the SUBMITTED-repair loop will (correctly) keep retrying next tick.
  const broadcastConfirmed = await a2aDeliveryMessageBroadcast(jobId, engagement.okxBuyerAgentId);
  if (!broadcastConfirmed) {
    console.warn(`[okx-delivery] ${jobId}: re-sent deliverable but session history has not confirmed it — will retry next tick.`);
    return { ok: false, submitted: true, error: 'broadcast not confirmed in session history' };
  }

  engagement.deliverableSentAt = now();
  saveEngagement(engagement);
  console.log(`[okx-delivery] ${jobId}: deliverable re-sent and confirmed to buyer agent ${engagement.okxBuyerAgentId}`);
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
