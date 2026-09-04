import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { config } from './config.js';
import { criteriaToProfile, runAdhocHunt, type HuntCriteria } from './skills/jobHunt.js';
import { scorePosting } from './skills/matchScorer.js';
import { tailorApplication } from './skills/applicationTailor.js';
import { runRedflag, type RedflagInput } from './track3/redflag.js';
import { findService, serviceCatalog, type PricedService } from './payments/services.js';
import { verifyServicePayment } from './payments/verify.js';
import { handleMinerRoute, isMinerRoute } from './miner/miner.js';
import { handleTrack3Route, isTrack3Route } from './track3/routes.js';
import { llmHealth } from './llm.js';
import { telegraphHealth } from './track3/telegraph.js';
import { now, saveRedflagReport, uid } from './db.js';
import { clientIp, json, PREVIEW_LIMIT, rateAllowed, readBody } from './http.js';
import type { Posting, Profile } from './types.js';

/**
 * The composition root for every HTTP surface this process serves:
 *
 *   1. Core paid API — /api/* per-call endpoints (Base Sepolia billing)
 *   2. Miner surface — src/miner/, the Telegraph routes (src/miner/miner.ts)
 *   3. Track 3 web app — src/track3/, the Telegraph consumer surface
 *      (src/track3/routes.ts)
 *
 * Each surface owns its own routing module and is delegated to from here.
 */

const previewHits = new Map<string, number[]>();

function previewAllowed(ip: string): { ok: boolean; remaining: number; retryAfterSec: number } {
  return rateAllowed(previewHits, ip);
}

async function runService(service: PricedService, body: Record<string, unknown>, payerWallet?: string): Promise<unknown> {
  if (service.id === 'job-hunt') {
    const result = await runAdhocHunt(body as HuntCriteria);
    return { found: result.found, matches: result.matches.map((match) => ({ posting: match.posting, score: match.breakdown.total, breakdown: match.breakdown })), sourceErrors: result.sourceErrors };
  }
  if (service.id === 'score-posting') {
    const criteria = (body.criteria ?? {}) as HuntCriteria;
    const input = (body.posting ?? {}) as Partial<Posting>;
    if (!input.title || !input.company || !input.description) throw new Error('posting requires title, company, description');
    const posting: Posting = { id: 'api', source: 'api', externalId: 'api', title: input.title, company: input.company, location: input.location ?? '', remote: /remote/i.test(`${input.location ?? ''} ${input.description}`), compMin: input.compMin, compMax: input.compMax, description: input.description, url: input.url ?? '', atsHint: 'unknown', fetchedAt: new Date().toISOString() };
    const breakdown = await scorePosting(criteriaToProfile(criteria, 'api-score'), posting);
    return { score: breakdown.total, breakdown };
  }
  if (service.id === 'tailor-application') {
    const candidate = (body.candidate ?? {}) as { name?: string; resumeText?: string; skills?: string[]; email?: string };
    const input = (body.posting ?? {}) as Partial<Posting>;
    if (!candidate.name || !candidate.resumeText || !candidate.skills) throw new Error('candidate requires name, resumeText, skills');
    if (!input.title || !input.company || !input.description) throw new Error('posting requires title, company, description');
    const profile: Profile = { userId: `api-tailor-${Date.now()}`, name: candidate.name, targetRoles: [], seniority: 'mid', locations: [], remoteOk: true, compFloor: 0, skills: candidate.skills, resumeText: candidate.resumeText, dealbreakers: [], threshold: 0, dailyCap: 10, email: candidate.email };
    const posting: Posting = { id: `api-${Date.now()}`, source: 'api', externalId: 'api', title: input.title, company: input.company, location: input.location ?? '', remote: false, compMin: input.compMin, compMax: input.compMax, description: input.description, url: input.url ?? '', atsHint: input.atsHint ?? 'unknown', fetchedAt: new Date().toISOString() };
    const draft = await tailorApplication(profile, posting);
    return { resume: draft.resumeText, coverLetter: draft.coverLetter, emailSubject: draft.emailSubject, emailBody: draft.emailBody };
  }
  if (service.id === 'redflag-vetting') {
    const input = (body.redflag ?? body) as Partial<RedflagInput>;
    const text = [input.text, input.description, input.company].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    if (!text.length) throw new Error('send a job posting (company/description/text) to vet');
    const result = await runRedflag(input as RedflagInput);
    const degraded = !result.checks.some((c) => c.source === 'telegraph' && (c.status === 'ok' || c.status === 'cached'));
    // Reports persist as dispute evidence: what was checked, what it cost,
    // and what the buyer's money bought.
    saveRedflagReport({
      id: uid(),
      userId: `wallet:${String(payerWallet ?? 'anonymous')}`,
      company: result.company,
      verdict: result.verdict,
      spendUsd: result.spendUsd,
      at: now(),
      data: result,
    });
    return { ...result, degraded };
  }
  throw new Error(`no handler for service ${service.id}`);
}

async function handlePreview(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const gate = previewAllowed(clientIp(req));
  if (!gate.ok) return json(res, 429, { ok: false, error: `Free preview limit reached (${PREVIEW_LIMIT}/hour)`, retryAfterSeconds: gate.retryAfterSec });
  const raw = await readBody(req, res);
  if (raw === null) return;
  try {
    const result = await runAdhocHunt(raw ? JSON.parse(raw) as HuntCriteria : {});
    const matches = result.matches.slice(0, 3).map((match) => ({ title: match.posting.title, company: match.posting.company, location: match.posting.location, url: match.posting.url, score: match.breakdown.total, why: [match.breakdown.skills.reason, match.breakdown.comp.reason] }));
    json(res, 200, { ok: true, shown: matches.length, totalMatches: result.matches.length, previewsRemainingThisHour: gate.remaining, matches });
  } catch (error) {
    json(res, 400, { ok: false, error: String(error) });
  }
}

async function handlePaidRoute(service: PricedService, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const transactionHash = req.headers['x-payment-tx'];
  const payer = req.headers['x-user-wallet'];
  if (typeof transactionHash !== 'string' || typeof payer !== 'string') {
    return json(res, 402, { ok: false, error: 'Payment required', payment: { chain: 'Base Sepolia', chainId: config.payments.chainId, asset: config.payments.asset, symbol: config.payments.assetSymbol, amount: service.priceAtomic, priceUsd: service.priceUsd, payTo: config.payments.payTo } });
  }
  const raw = await readBody(req, res);
  if (raw === null) return;
  let body: Record<string, unknown>;
  try {
    body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  } catch (error) {
    return json(res, 400, { ok: false, error: `request body is not valid JSON: ${String(error)}` });
  }
  try {
    const payment = await verifyServicePayment(transactionHash, payer, service);
    if (!payment.ok) return json(res, 402, { ok: false, error: payment.error });
    const result = await runService(service, body, payer);
    json(res, 200, { ok: true, service: service.id, billing: 'base-sepolia', transactionHash, result });
  } catch (error) {
    json(res, 400, { ok: false, error: String(error), paid: true, transactionHash });
  }
}

export function startServer(port: number = config.server.endpointPort): Server {
  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '').split('?')[0];
      if (req.method === 'GET' && path === '/health')
        return json(res, 200, {
          ok: true,
          agent: 'Legwork',
          chain: 'Base Sepolia',
          miner: 'legwork-job-hunter',
          // Key validity, not just presence: a dead key silently degrades every
          // scored response to the heuristic/template path.
          llm: llmHealth(),
          // The consumer side of Telegraph: Redflag buys miner answers here.
          telegraph: telegraphHealth(),
          sources: { adzuna: config.adzuna.enabled, usajobs: config.usajobs.enabled },
        });
      if (req.method === 'GET' && path === '/api/services') return json(res, 200, serviceCatalog());
      if (req.method === 'POST' && path === '/api/hunt/preview') return handlePreview(req, res);
      if (isTrack3Route(req.method, path)) return handleTrack3Route(req, res, path);
      if (isMinerRoute(req.method, path)) return handleMinerRoute(req, res, path);
      const service = findService(req.method, path);
      if (service) return handlePaidRoute(service, req, res);
      res.writeHead(404);
      res.end();
    })().catch((error) => {
      console.error('[server] handler error:', error);
      if (!res.headersSent) json(res, 500, { ok: false, error: 'internal error' });
    });
  });
  server.listen(port, () => console.log(`[server] listening on :${(server.address() as { port: number }).port}`));
  return server;
}
