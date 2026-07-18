import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { PAYMENT_HEADERS, buildChallenge, findService, serviceCatalog, verifyAndSettle, type PricedService } from './x402.js';
import { criteriaToProfile, runAdhocHunt, type HuntCriteria } from '../skills/jobHunt.js';
import { scorePosting } from '../skills/matchScorer.js';
import { tailorApplication } from '../skills/applicationTailor.js';
import type { Posting, Profile } from '../types.js';
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

/**
 * Marketplace catalog. `job-hunt` is the entry product and the DEFAULT
 * listing: criteria in → approved → ranked shortlist out. No resume, no
 * email access, no submission liability. See PRICING.md for the rationale.
 */
export const LISTINGS = {
  'job-hunt': {
    title: 'Job Hunt — ranked shortlist',
    description:
      'Give your criteria (roles, location, qualification, comp floor, skills, priority factors). ' +
      'After you approve them, the agent hunts all day and returns a ranked, fully-explained shortlist of up to 10 matches.',
    priceUsd: '2.00',
    days: 1,
  },
  'job-hunt-weekly': {
    title: 'Job Hunt — weekly (7 days)',
    description: 'Same criteria-approved hunt, running daily for 7 days with fresh shortlists (deduped — never the same posting twice).',
    priceUsd: '9.00',
    days: 7,
  },
  'tailor-one-application': {
    title: 'Tailor one application',
    description: 'One posting: tailored resume variant + cover letter, delivered for your approval. Never fabricates.',
    priceUsd: '4.00',
    days: 1,
  },
  'job-search-sprint-7d': {
    title: 'Job Search Sprint (7 days) — full loop',
    description: 'Daily hunt + tailored drafts for top matches + approval-gated submission + weekly digest. The whole search.',
    priceUsd: '19.00',
    days: 7,
  },
} as const;

export type ListingId = keyof typeof LISTINGS;

function resolveListing(env: OkxEnvelope): ListingId {
  const requested = String(env.message?.listing ?? '');
  return (requested in LISTINGS ? requested : 'job-hunt') as ListingId;
}

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
      const listingId = resolveListing(env);
      const listing = LISTINGS[listingId];
      engagement = {
        id: uid(),
        okxJobId: jobId,
        okxBuyerAgentId: env.sender?.agentId,
        taskCode: newTaskCode(),
        listing: listingId,
        status: 'awaiting_link',
        startedAt: now(),
        endsAt: new Date(Date.now() + listing.days * 86400_000).toISOString(),
      };
      saveEngagement(engagement);
      savePayment({
        id: uid(),
        engagementId: engagement.id,
        okxJobId: jobId,
        kind: 'escrow',
        amount: listing.priceUsd,
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
  // Hunt listings deliver the shortlist; full-loop listings deliver the
  // digest + approval/submission evidence bundle.
  const deliverable =
    engagement.listing.startsWith('job-hunt') && engagement.shortlist
      ? engagement.shortlist
      : buildDigest(engagement) + '\n\n' + buildEvidenceBundle(engagement);
  audit('okx-endpoint', 'DELIVERED', `job=${engagement.okxJobId}`);
  // In production this posts to the OKX task `deliver` API; the payload is
  // returned so the caller (or the marketplace poller) can transmit it.
  return deliverable;
}

// ── HTTP plumbing ──────────────────────────────────────────────────────────

function readBody(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  return new Promise((resolve) => {
    let body = '';
    let overflow = false;
    req.on('data', (c) => {
      body += c;
      if (body.length > 1_000_000) {
        overflow = true;
        res.writeHead(413);
        res.end('payload too large');
        req.destroy();
        resolve(null);
      }
    });
    req.on('end', () => resolve(overflow ? null : body));
  });
}

function json(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(data));
}

// ── paid x402 API handlers ─────────────────────────────────────────────────

async function runPaidService(service: PricedService, body: Record<string, unknown>): Promise<unknown> {
  switch (service.id) {
    case 'job-hunt': {
      const result = await runAdhocHunt(body as HuntCriteria);
      return {
        found: result.found,
        matches: result.matches.map((m) => ({ posting: m.posting, score: m.breakdown.total, breakdown: m.breakdown })),
        sourceErrors: result.sourceErrors,
      };
    }
    case 'score-posting': {
      const criteria = (body.criteria ?? {}) as HuntCriteria;
      const p = (body.posting ?? {}) as Partial<Posting>;
      if (!p.title || !p.company || !p.description) throw new Error('posting requires title, company, description');
      const posting: Posting = {
        id: 'api', source: 'api', externalId: 'api', title: p.title, company: p.company,
        location: p.location ?? '', remote: /remote/i.test(`${p.location ?? ''} ${p.description}`),
        compMin: p.compMin, compMax: p.compMax, description: p.description, url: p.url ?? '',
        atsHint: 'unknown', fetchedAt: new Date().toISOString(),
      };
      const breakdown = await scorePosting(criteriaToProfile(criteria, 'api-score'), posting);
      return { score: breakdown.total, breakdown };
    }
    case 'tailor-application': {
      const c = (body.candidate ?? {}) as { name?: string; resumeText?: string; skills?: string[]; email?: string };
      const p = (body.posting ?? {}) as Partial<Posting>;
      if (!c.name || !c.resumeText || !c.skills) throw new Error('candidate requires name, resumeText, skills');
      if (!p.title || !p.company || !p.description) throw new Error('posting requires title, company, description');
      const profile: Profile = {
        userId: `api-tailor-${Date.now()}`, name: c.name, targetRoles: [], seniority: 'mid',
        locations: [], remoteOk: true, compFloor: 0, skills: c.skills, resumeText: c.resumeText,
        dealbreakers: [], threshold: 0, dailyCap: 10, email: c.email,
      };
      const posting: Posting = {
        id: `api-${Date.now()}`, source: 'api', externalId: 'api', title: p.title!, company: p.company!,
        location: p.location ?? '', remote: false, compMin: p.compMin, compMax: p.compMax,
        description: p.description!, url: p.url ?? '', atsHint: p.atsHint ?? 'unknown',
        fetchedAt: new Date().toISOString(),
      };
      const draft = await tailorApplication(profile, posting);
      return { resume: draft.resumeText, coverLetter: draft.coverLetter, emailSubject: draft.emailSubject, emailBody: draft.emailBody };
    }
    default:
      throw new Error(`no handler for service ${service.id}`);
  }
}

async function handlePaidRoute(service: PricedService, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const resource = `${config.okx.publicUrl ?? ''}${service.path}` || service.path;
  // x402 v2 buyers send `PAYMENT-SIGNATURE`; legacy v1 sends `X-PAYMENT`.
  let paymentHeader: string | undefined;
  for (const name of PAYMENT_HEADERS) {
    const v = req.headers[name];
    if (typeof v === 'string' && v.length) {
      paymentHeader = v;
      break;
    }
  }

  // No payment → 402 challenge (v2 header + v1 body).
  if (!paymentHeader) {
    const challenge = buildChallenge(service, resource);
    json(res, 402, challenge.bodyV1, { 'PAYMENT-REQUIRED': challenge.headerValue });
    return;
  }

  // Payment attached → verify + settle BEFORE doing any work.
  const verdict = await verifyAndSettle(paymentHeader, service, resource);
  if (!verdict.ok) {
    const challenge = buildChallenge(service, resource);
    json(res, verdict.status, { ...challenge.bodyV1, error: verdict.error }, { 'PAYMENT-REQUIRED': challenge.headerValue });
    return;
  }

  const raw = await readBody(req, res);
  if (raw === null) return;
  try {
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const result = await runPaidService(service, body);
    json(res, 200, { ok: true, service: service.id, result }, { 'PAYMENT-RESPONSE': verdict.responseHeader! });
  } catch (err) {
    // Work failed AFTER a successful charge — record it so support/refunds
    // have a trail. (Facilitator refund flow is a follow-up.)
    audit('x402', 'PAID_CALL_FAILED', `service=${service.id} payer=${verdict.payer} err=${String(err)}`);
    json(res, 400, { ok: false, error: String(err), paid: true, transaction: verdict.transaction }, { 'PAYMENT-RESPONSE': verdict.responseHeader! });
  }
}

export function startOkxServer(handlers: OkxHandlers = {}, port: number = config.okx.endpointPort): Server {
  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '').split('?')[0];

      if (req.method === 'GET' && path === '/health') {
        return json(res, 200, { ok: true, agent: config.okx.agentId });
      }

      // Free, public service catalog — what agent directories index.
      if (req.method === 'GET' && path === '/api/services') {
        return json(res, 200, serviceCatalog());
      }

      // Paid x402-gated services.
      const service = findService(req.method ?? undefined, path);
      if (service) return handlePaidRoute(service, req, res);

      if (req.method === 'POST' && path === '/okx/a2a') {
        // Reject anything not from OKX (shared secret until registry signature
        // verification is wired).
        if (config.okx.inboundSecret && req.headers['x-okx-secret'] !== config.okx.inboundSecret) {
          res.writeHead(401);
          res.end('unauthorized');
          return;
        }
        const body = await readBody(req, res);
        if (body === null) return;
        try {
          const env = JSON.parse(body) as OkxEnvelope;
          return json(res, 200, handleEnvelope(env, handlers));
        } catch (err) {
          return json(res, 400, { ok: false, error: String(err) });
        }
      }

      res.writeHead(404);
      res.end();
    })().catch((err) => {
      console.error('[okx] handler error:', err);
      if (!res.headersSent) json(res, 500, { ok: false, error: 'internal error' });
    });
  });
  server.listen(port, () => {
    const addr = server.address();
    const actual = typeof addr === 'object' && addr ? addr.port : port;
    console.log(`[okx] endpoint listening on :${actual} (POST /okx/a2a, GET /api/services, paid /api/* via x402)`);
  });
  return server;
}
