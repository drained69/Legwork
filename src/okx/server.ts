import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import {
  audit,
  getEngagementByJob,
  now,
  saveEngagement,
  savePayment,
  uid,
} from '../db.js';
import { buildDigest, buildEvidenceBundle } from '../digest.js';
import type { Engagement, OkxEnvelope } from '../types.js';

/**
 * Inbound A2A service endpoint — the URL registered on the OKX ERC-8004
 * agent registry. OKX delivers task lifecycle events and buyer chat here.
 *
 * Every engagement Legwork runs starts life as an OKX task: hire happens on
 * the marketplace, this endpoint receives `task_assigned`, and we hand back
 * a one-time Telegram deep link that binds the buyer to their thread.
 */

export const LISTINGS = {
  'job-search-sprint-7d': {
    title: 'Job Search Sprint (7 days)',
    description: 'Daily scan + rubric scoring + tailored drafts + approval-gated submission + weekly digest.',
    priceUsd: '25.00',
    days: 7,
  },
  'tailor-one-application': {
    title: 'Tailor one application',
    description: 'One posting: tailored resume variant + cover letter, delivered for your approval.',
    priceUsd: '3.00',
    days: 1,
  },
} as const;

function newTaskCode(): string {
  return randomBytes(6).toString('hex');
}

export interface OkxHandlers {
  /** Called when a buyer accepts delivery → notify the bound Telegram user. */
  onSettled?: (engagement: Engagement) => Promise<void> | void;
}

export function handleEnvelope(env: OkxEnvelope, handlers: OkxHandlers = {}): Record<string, unknown> {
  const jobId = env.jobId ?? env.message?.jobId;
  const event = env.message?.source === 'system' ? env.message.event : undefined;
  audit('okx-endpoint', 'ENVELOPE', JSON.stringify({ jobId, event, msgType: env.msgType }).slice(0, 500));

  // ── system lifecycle events ──────────────────────────────────────────────
  if (event === 'task_assigned' || event === 'task_created') {
    if (!jobId) return { ok: false, error: 'missing jobId' };
    let engagement = getEngagementByJob(jobId);
    if (!engagement) {
      engagement = {
        id: uid(),
        okxJobId: jobId,
        okxBuyerAgentId: env.sender?.agentId,
        taskCode: newTaskCode(),
        listing: 'job-search-sprint-7d',
        status: 'awaiting_link',
        startedAt: now(),
        endsAt: new Date(Date.now() + LISTINGS['job-search-sprint-7d'].days * 86400_000).toISOString(),
      };
      saveEngagement(engagement);
      savePayment({
        id: uid(),
        engagementId: engagement.id,
        okxJobId: jobId,
        kind: 'escrow',
        amount: LISTINGS['job-search-sprint-7d'].priceUsd,
        currency: 'USD',
        raw: JSON.stringify(env).slice(0, 1000),
        at: now(),
      });
    }
    const deepLink = `https://t.me/${config.telegram.username}?start=${engagement.taskCode}`;
    return {
      ok: true,
      reply:
        `Legwork accepted your task. Open your private Telegram thread to onboard and run the engagement: ${deepLink}\n` +
        `Everything happens in that thread — profile setup, match cards, approvals, and your weekly digest.`,
    };
  }

  if (event === 'delivery_accepted') {
    if (!jobId) return { ok: false, error: 'missing jobId' };
    const engagement = getEngagementByJob(jobId);
    if (engagement) {
      engagement.status = 'settled';
      saveEngagement(engagement);
      savePayment({
        id: uid(), engagementId: engagement.id, okxJobId: jobId, kind: 'settle',
        raw: JSON.stringify(env).slice(0, 1000), at: now(),
      });
      void handlers.onSettled?.(engagement);
    }
    return { ok: true };
  }

  if (event === 'dispute_opened') {
    if (!jobId) return { ok: false, error: 'missing jobId' };
    const engagement = getEngagementByJob(jobId);
    if (!engagement) return { ok: false, error: 'unknown job' };
    engagement.status = 'disputed';
    saveEngagement(engagement);
    // Evidence bundle: approvals log + frozen drafts + submission receipts.
    return { ok: true, evidence: buildEvidenceBundle(engagement) };
  }

  // ── buyer chat through the marketplace ───────────────────────────────────
  if (env.msgType === 'a2a-agent-chat' && jobId) {
    const engagement = getEngagementByJob(jobId);
    if (!engagement) return { ok: false, error: 'unknown job' };
    const text = env.parts?.find((p) => p.kind === 'text')?.text?.toLowerCase() ?? '';
    if (text.includes('status') || text.includes('digest')) {
      return { ok: true, reply: buildDigest(engagement) };
    }
    const deepLink = `https://t.me/${config.telegram.username}?start=${engagement.taskCode}`;
    return {
      ok: true,
      reply: `This engagement runs in your Telegram thread: ${deepLink}. Send "status" here anytime for a digest.`,
    };
  }

  return { ok: true, note: 'event ignored' };
}

/** Submit the deliverable back through the OKX task lifecycle. */
export function deliverEngagement(engagement: Engagement): string {
  engagement.status = 'delivering';
  saveEngagement(engagement);
  const deliverable = buildDigest(engagement) + '\n\n' + buildEvidenceBundle(engagement);
  audit('okx-endpoint', 'DELIVERED', `job=${engagement.okxJobId}`);
  // In production this posts to the OKX task `deliver` API; the payload is
  // returned so the caller (or the marketplace poller) can transmit it.
  return deliverable;
}

export function startOkxServer(handlers: OkxHandlers = {}): void {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, agent: config.okx.agentId }));
      return;
    }
    if (req.method === 'POST' && req.url === '/okx/a2a') {
      // Reject anything not from OKX (shared secret until registry signature
      // verification is wired).
      if (config.okx.inboundSecret && req.headers['x-okx-secret'] !== config.okx.inboundSecret) {
        res.writeHead(401);
        res.end('unauthorized');
        return;
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const env = JSON.parse(body) as OkxEnvelope;
          const result = handleEnvelope(env, handlers);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(err) }));
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(config.okx.endpointPort, () => {
    console.log(`[okx] A2A endpoint listening on :${config.okx.endpointPort} (POST /okx/a2a)`);
  });
}
