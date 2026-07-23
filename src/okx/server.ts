import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { PAYMENT_HEADERS, buildChallenge, findService, serviceCatalog, verifyAndSettle, type PricedService } from './x402.js';
import { repairDeliverable, submitDeliverable } from './delivery.js';
import { criteriaToProfile, runAdhocHunt, type HuntCriteria } from '../skills/jobHunt.js';
import { scorePosting } from '../skills/matchScorer.js';
import { tailorApplication } from '../skills/applicationTailor.js';
import type { Posting, Profile } from '../types.js';
import {
  audit,
  countUsage,
  getEngagementById,
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
/**
 * LAUNCH PRICING. Each bundle is priced just above the API-call value of the
 * work it contains (a 24h hunt = 4 scheduled hunts = $0.20 of calls), so the
 * two channels stay coherent and a first-time buyer risks pocket change.
 * Revisit once there is retention data — see PRICING.md.
 */
export const LISTINGS = {
  'job-hunt': {
    title: 'Job Hunt — ranked shortlist',
    description:
      'Give your criteria (roles, location, qualification, comp floor, skills, priority factors). ' +
      'After you approve them, the agent hunts all day and returns a ranked, fully-explained shortlist of up to 10 matches.',
    priceUsd: '0.25',
    days: 1,
  },
  'job-hunt-weekly': {
    title: 'Job Hunt — weekly (7 days)',
    description: 'Same criteria-approved hunt, running daily for 7 days with fresh shortlists (deduped — never the same posting twice).',
    priceUsd: '1.00',
    days: 7,
  },
  'tailor-one-application': {
    title: 'Tailor one application',
    description: 'One posting: tailored resume variant + cover letter, delivered for your approval. Never fabricates.',
    priceUsd: '0.25',
    days: 1,
  },
  'job-search-sprint-7d': {
    title: 'Job Search Sprint (7 days) — full loop',
    description: 'Daily hunt + tailored drafts for top matches + approval-gated submission + weekly digest. The whole search.',
    priceUsd: '2.00',
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
  /**
   * Called for every system event. Wired to the marketplace poller so a push
   * and a pull converge on the same state instead of racing: whatever the
   * event was, re-reading the task list settles what to do about it.
   */
  onSystemEvent?: (event: string, jobId?: string) => void;
}

/**
 * OKX task lifecycle event names, grouped by what they mean for this agent.
 *
 * The legacy `task_*` / `delivery_accepted` / `dispute_opened` names are kept
 * as aliases: they are what the demo and the test suite speak, and dropping
 * them would break a working local flow to no benefit.
 */
const EVENTS = {
  /** A task now names this agent — the claim clock is running. */
  assigned: ['job_created', 'job_asp_selected', 'task_assigned', 'task_created'],
  /** Escrow funded; the delivery window is open. */
  accepted: ['job_accepted', 'task_accepted'],
  /** Buyer accepted the deliverable; funds released. */
  settled: ['job_completed', 'job_auto_completed', 'delivery_accepted'],
  /** Buyer pushed back — evidence matters from here on. */
  contested: ['job_disputed', 'job_rejected', 'dispute_opened'],
  /** Terminal without payment. */
  closed: ['job_expired', 'job_closed', 'job_refunded', 'job_auto_refunded'],
} as const;

/**
 * Accumulate the buyer's brief across messages, newest last.
 *
 * Bounded so a chatty counterparty cannot grow the row without limit, and
 * de-duplicated so a resent message does not double-weight its terms.
 */
export function appendBrief(existing: string | undefined, addition: string): string {
  const prior = (existing ?? '').trim();
  if (!addition) return prior;
  if (prior.includes(addition)) return prior;
  const merged = prior ? `${prior}\n${addition}` : addition;
  return merged.length > 8000 ? merged.slice(merged.length - 8000) : merged;
}

export function handleEnvelope(env: OkxEnvelope, handlers: OkxHandlers = {}): Record<string, unknown> {
  const jobId = env.jobId ?? env.message?.jobId;
  const event = env.message?.source === 'system' ? env.message.event : undefined;
  audit('okx-endpoint', 'ENVELOPE', JSON.stringify({ jobId, event, msgType: env.msgType }).slice(0, 500));
  if (event) handlers.onSystemEvent?.(event, jobId);

  // ── system lifecycle events ──────────────────────────────────────────────
  if (event && EVENTS.assigned.includes(event as (typeof EVENTS.assigned)[number])) {
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

  // Escrow funded. The poller does the work and submits it — the reply here
  // only has to acknowledge, and must not block the marketplace's request on
  // a job hunt that takes tens of seconds.
  if (event && EVENTS.accepted.includes(event as (typeof EVENTS.accepted)[number])) {
    if (!jobId) return { ok: false, error: 'missing jobId' };
    const engagement = getEngagementByJob(jobId);
    if (engagement && engagement.status === 'awaiting_link') {
      engagement.status = 'active';
      saveEngagement(engagement);
    }
    return { ok: true, reply: 'Accepted — Legwork is running your hunt now and will submit the deliverable shortly.' };
  }

  if (event && EVENTS.settled.includes(event as (typeof EVENTS.settled)[number])) {
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

  if (event && EVENTS.contested.includes(event as (typeof EVENTS.contested)[number])) {
    if (!jobId) return { ok: false, error: 'missing jobId' };
    const engagement = getEngagementByJob(jobId);
    if (!engagement) return { ok: false, error: 'unknown job' };
    engagement.status = 'disputed';
    saveEngagement(engagement);
    // Evidence bundle: approvals log + frozen drafts + submission receipts.
    return { ok: true, evidence: buildEvidenceBundle(engagement) };
  }

  if (event && EVENTS.closed.includes(event as (typeof EVENTS.closed)[number])) {
    if (!jobId) return { ok: false, error: 'missing jobId' };
    const engagement = getEngagementByJob(jobId);
    if (engagement) {
      engagement.status = 'closed';
      saveEngagement(engagement);
      audit('okx-endpoint', 'CLOSED', `job=${jobId} event=${event}`);
    }
    return { ok: true };
  }

  // ── buyer chat through the marketplace ───────────────────────────────────
  if (env.msgType === 'a2a-agent-chat' && jobId) {
    const engagement = getEngagementByJob(jobId);
    if (!engagement) return { ok: false, error: 'unknown job' };
    const raw = env.parts?.find((p) => p.kind === 'text')?.text ?? '';
    const text = raw.toLowerCase();
    if (text.includes('status') || text.includes('digest')) {
      return { ok: true, reply: buildDigest(engagement) };
    }

    // THIS is where the buyer's requirements arrive.
    //
    // `active-tasks` and `agent status` return a title and a budget — no
    // description field exists on either — so the marketplace never hands us
    // the brief. The buyer's User Agent sends it here instead, in the chat
    // opened by `contact-user`. This handler used to lowercase the text, test
    // it for "status", and discard it, so the salary floor, the required
    // skills and the target locations were thrown away and the hunt ran on the
    // task TITLE alone — which is exactly how a $140k Python/Go brief became
    // "mid, remote, $0+ floor" with no skills.
    //
    // Appended rather than replaced: requirements often arrive across several
    // messages, and a later "also, remote only" must not erase the first.
    if (raw.trim()) {
      engagement.brief = appendBrief(engagement.brief, raw.trim());
      saveEngagement(engagement);
      audit('okx-endpoint', 'BRIEF_CAPTURED', `job=${jobId} chars=${raw.trim().length}`);
    }

    return {
      ok: true,
      reply:
        'Got it — those requirements are recorded and the hunt runs against them. ' +
        'The ranked shortlist is delivered to this task. Send "status" here any time for progress.',
    };
  }

  return { ok: true, note: 'event ignored' };
}

/**
 * Build the deliverable payload for an engagement (pure — no I/O).
 *
 * Building is not delivering: this only assembles the bytes. The audit trail
 * records that distinction, because an audit line saying DELIVERED for a
 * payload that was never transmitted is precisely what makes an empty
 * submission impossible to diagnose after the fact.
 */
export function deliverEngagement(engagement: Engagement): string {
  engagement.status = 'delivering';
  saveEngagement(engagement);
  // Hunt listings deliver the shortlist; full-loop listings deliver the
  // digest + approval/submission evidence bundle.
  const deliverable =
    engagement.listing.startsWith('job-hunt') && engagement.shortlist
      ? engagement.shortlist
      : buildDigest(engagement) + '\n\n' + buildEvidenceBundle(engagement);
  audit('okx-endpoint', 'DELIVERABLE_BUILT', `job=${engagement.okxJobId}`);
  return deliverable;
}

/**
 * Build the deliverable AND get it to the buyer.
 *
 * `deliverEngagement` alone only ever produced a string — nothing transmitted
 * it, so an engagement that "completed" locally still hit the marketplace's
 * submit timeout and auto-refunded the buyer.
 *
 * `ok` means the buyer can retrieve the payload, not merely that a tx landed
 * (see okx/delivery.ts). Re-entrant by design: an engagement whose submit
 * already went on-chain cannot be delivered again, so it takes the repair path
 * instead of re-submitting into a CLI that would reject it.
 */
export async function deliverEngagementOnChain(engagement: Engagement): Promise<{ ok: boolean; deliverable: string; error?: string }> {
  const deliverable = deliverEngagement(engagement);

  const res = engagement.deliveredAt
    ? await repairDeliverable(engagement, deliverable)
    : await submitDeliverable(engagement, deliverable, 'Legwork engagement deliverable — full report attached.');

  return { ok: res.ok, deliverable, error: res.error };
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

// ── free preview (try-before-you-pay) ──────────────────────────────────────

/** Sliding-window rate limit so the free tier can't be farmed for full value. */
const PREVIEW_LIMIT = 3;
const PREVIEW_WINDOW_MS = 60 * 60 * 1000;
const previewHits = new Map<string, number[]>();

function previewAllowed(ip: string): { ok: boolean; remaining: number; retryAfterSec: number } {
  const cutoff = Date.now() - PREVIEW_WINDOW_MS;
  const hits = (previewHits.get(ip) ?? []).filter((t) => t > cutoff);
  if (previewHits.size > 10_000) evictExpired(cutoff);
  if (hits.length >= PREVIEW_LIMIT) {
    return { ok: false, remaining: 0, retryAfterSec: Math.ceil((hits[0] + PREVIEW_WINDOW_MS - Date.now()) / 1000) };
  }
  hits.push(Date.now());
  previewHits.set(ip, hits);
  return { ok: true, remaining: PREVIEW_LIMIT - hits.length, retryAfterSec: 0 };
}

/**
 * Bound the map by dropping only entries whose window has fully elapsed.
 *
 * The previous version called `previewHits.clear()`, which reset EVERY
 * client's counter — so anyone able to grow the map past the bound (trivial,
 * since keys came from a client-settable header) also wiped their own limit.
 */
function evictExpired(cutoff: number): void {
  for (const [key, times] of previewHits) {
    if (!times.some((t) => t > cutoff)) previewHits.delete(key);
  }
}

/**
 * The client's real address, as far as we can actually trust it.
 *
 * X-Forwarded-For is append-only: each proxy adds the peer it heard from, so
 * the RIGHTMOST entry is the one our own proxy observed and the leftmost is
 * whatever the client typed. Reading the leftmost — as this did — let any
 * caller mint a fresh identity per request with a made-up header and farm the
 * free tier without limit. Trust the socket peer, and only step one hop left
 * of it when a trusted proxy is actually in front of us.
 */
/** Loopback callers are this process talking to itself (the Telegram bot). */
function isLoopback(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function clientIp(req: IncomingMessage): string {
  const socketIp = req.socket.remoteAddress ?? 'unknown';

  // The Telegram bot calls this API over loopback, so EVERY Telegram user
  // arrived as 127.0.0.1 and they all shared one 3/hour bucket — the free
  // preview stopped working for everyone after three uses in an hour. A
  // loopback caller is our own process, so its declared per-user key is
  // trustworthy in a way a remote caller's headers never are.
  if (isLoopback(socketIp)) {
    const key = req.headers['x-internal-client'];
    if (typeof key === 'string' && key.length) return `internal:${key.slice(0, 100)}`;
  }

  if (!config.okx.trustProxy) return socketIp;
  const fwd = req.headers['x-forwarded-for'];
  const chain = (Array.isArray(fwd) ? fwd.join(',') : fwd ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // Rightmost = added by the proxy adjacent to us; anything further left is
  // client-controlled and must never be used as a rate-limit key.
  return chain.length ? chain[chain.length - 1] : socketIp;
}

/**
 * FREE preview: same hunt, top 3 matches only, scores + the two headline
 * score reasons. Exists so buyers (human or agent) can judge quality before
 * paying — the paid call returns all 10 with full per-axis breakdowns.
 */
async function handlePreview(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const gate = previewAllowed(clientIp(req));
  if (!gate.ok) {
    return json(res, 429, {
      ok: false,
      error: `Free preview limit reached (${PREVIEW_LIMIT}/hour). Try again later, or call POST /api/hunt for the full paid shortlist.`,
      retryAfterSeconds: gate.retryAfterSec,
    }, { 'retry-after': String(gate.retryAfterSec) });
  }
  const raw = await readBody(req, res);
  if (raw === null) return;
  try {
    const criteria = raw ? (JSON.parse(raw) as HuntCriteria) : {};
    const result = await runAdhocHunt(criteria);
    const preview = result.matches.slice(0, 3).map((m) => ({
      title: m.posting.title,
      company: m.posting.company,
      location: m.posting.location,
      url: m.posting.url,
      score: m.breakdown.total,
      why: [m.breakdown.skills.reason, m.breakdown.comp.reason],
    }));
    json(res, 200, {
      ok: true,
      preview: true,
      shown: preview.length,
      totalMatches: result.matches.length,
      previewsRemainingThisHour: gate.remaining,
      matches: preview,
      upgrade: {
        message: `Showing top ${preview.length} of ${result.matches.length}. The paid call returns all matches with full per-axis breakdowns.`,
        endpoint: 'POST /api/hunt',
        priceUsd: '0.05',
      },
    });
  } catch (err) {
    json(res, 400, { ok: false, error: String(err) });
  }
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

/**
 * Engagement-authorized access: a buyer who already paid for a Telegram
 * engagement on the OKX marketplace must NOT be charged x402 again per call.
 * The bot presents the engagement id + an HMAC over it; we verify the
 * engagement exists, is live, and is within its call quota.
 */
const ENGAGEMENT_CALL_QUOTA: Record<string, number> = {
  'job-hunt': 40,
  'job-hunt-weekly': 250,
  'tailor-one-application': 10,
  'job-search-sprint-7d': 400,
};

export function engagementToken(engagementId: string): string {
  return createHmac('sha256', config.okx.inboundSecret || 'legwork-dev-secret').update(engagementId).digest('hex');
}

function engagementAuthorized(req: IncomingMessage): { ok: boolean; engagementId?: string; error?: string } {
  const id = req.headers['x-engagement-id'];
  const token = req.headers['x-engagement-token'];
  if (typeof id !== 'string' || typeof token !== 'string') return { ok: false };
  const expected = engagementToken(id);
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, error: 'invalid engagement token' };
  const engagement = getEngagementById(id);
  if (!engagement) return { ok: false, error: 'unknown engagement' };
  if (!['active', 'onboarding', 'delivering'].includes(engagement.status)) {
    return { ok: false, error: `engagement is ${engagement.status}` };
  }
  if (engagement.endsAt && new Date(engagement.endsAt) < new Date()) return { ok: false, error: 'engagement expired' };
  const quota = ENGAGEMENT_CALL_QUOTA[engagement.listing] ?? 40;
  if (countUsage(engagement.id) >= quota) return { ok: false, error: `engagement call quota (${quota}) reached` };
  return { ok: true, engagementId: engagement.id };
}

async function handlePaidRoute(service: PricedService, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const resource = `${config.okx.publicUrl ?? ''}${service.path}` || service.path;

  // Prepaid engagement path — no second charge for work already bought.
  const prepaid = engagementAuthorized(req);
  if (prepaid.ok) {
    const raw = await readBody(req, res);
    if (raw === null) return;
    try {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const result = await runPaidService(service, body);
      audit('x402', 'ENGAGEMENT_CALL', `service=${service.id} engagement=${prepaid.engagementId}`);
      return json(res, 200, { ok: true, service: service.id, billing: 'engagement', engagementId: prepaid.engagementId, result });
    } catch (err) {
      return json(res, 400, { ok: false, error: String(err) });
    }
  }
  if (prepaid.error) {
    return json(res, 402, { ok: false, error: prepaid.error, hint: 'Engagement no longer covers this call — pay per call via x402 or renew on the marketplace.' });
  }
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

  // Read and parse the request BEFORE settling. Parsing is not "the work" —
  // and charging for a request we are about to reject as malformed takes the
  // buyer's money for nothing. Note the ordering: an unpaid caller still gets
  // the 402 challenge above without us reading a byte of their body.
  const raw = await readBody(req, res);
  if (raw === null) return; // readBody already answered (413)
  let body: Record<string, unknown>;
  try {
    body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch (err) {
    return json(res, 400, { ok: false, error: `request body is not valid JSON: ${String(err)}`, charged: false });
  }

  // Input is well-formed → verify + settle BEFORE doing any work.
  const verdict = await verifyAndSettle(paymentHeader, service, resource);
  if (!verdict.ok) {
    const challenge = buildChallenge(service, resource);
    json(res, verdict.status, { ...challenge.bodyV1, error: verdict.error }, { 'PAYMENT-REQUIRED': challenge.headerValue });
    return;
  }

  try {
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

      // Free preview — try before you pay (rate-limited).
      if (req.method === 'POST' && path === '/api/hunt/preview') {
        return handlePreview(req, res);
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
